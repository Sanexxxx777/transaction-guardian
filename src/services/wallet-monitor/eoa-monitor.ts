import axios from 'axios';
import { prisma, isDatabaseHealthy } from '../../db/index.js';
import { redis, isRedisAvailable } from '../../db/redis.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { EtherscanTransaction } from '../../models/transaction.js';

const logger = createLogger('eoa-monitor');

const ETHERSCAN_V2_BASE = 'https://api.etherscan.io/v2/api';
const LAST_BLOCK_KEY = 'eoa_last_block';
const LAST_BLOCK_TTL = 90 * 24 * 60 * 60;

export interface EoaMonitorConfig {
  pollIntervalMs: number;
  onNewTransaction: (tx: EtherscanTransaction, walletId: string, walletAddress: string, chainId: number) => Promise<void>;
}

export class EoaMonitor {
  private config: EoaMonitorConfig;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;

  private lastBlockMemory = new Map<string, number>();

  constructor(cfg: EoaMonitorConfig) {
    this.config = cfg;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('EoaMonitor already running');
      return;
    }

    if (!config.etherscan.isConfigured) {
      logger.warn('Etherscan API key not configured, EOA monitoring disabled');
      return;
    }

    this.isRunning = true;
    logger.info('EoaMonitor started');
    await this.poll();
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('EoaMonitor stopped');
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    if (!isDatabaseHealthy()) {
      logger.warn('Database unhealthy, skipping EOA poll cycle');
      this.pollTimer = setTimeout(() => this.poll(), 10000);
      return;
    }

    try {
      await this.checkAllEoaWallets();
    } catch (error) {
      logger.error({ error }, 'Error during EOA poll cycle');
    }

    if (!this.isRunning) return;
    this.pollTimer = setTimeout(() => this.poll(), this.config.pollIntervalMs);
  }

  private async checkAllEoaWallets(): Promise<void> {
    let networks: Awaited<ReturnType<typeof prisma.network.findMany>>;
    let wallets: Awaited<ReturnType<typeof prisma.wallet.findMany>>;

    try {
      networks = await prisma.network.findMany({ where: { isEnabled: true } });
      wallets = await prisma.wallet.findMany({
        where: { isActive: true, type: 'eoa', monitoringEnabled: true },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch EOA wallets from DB');
      return;
    }

    if (wallets.length === 0) return;

    const walletsByChain = new Map<number, typeof wallets>();
    for (const w of wallets) {
      const arr = walletsByChain.get(w.chainId) || [];
      arr.push(w);
      walletsByChain.set(w.chainId, arr);
    }

    for (const network of networks) {
      const chainWallets = walletsByChain.get(network.chainId);
      if (!chainWallets || chainWallets.length === 0) continue;

      const chunks = chunkArray(chainWallets, 5);
      for (const chunk of chunks) {
        await Promise.allSettled(
          chunk.map(wallet =>
            this.checkEoaWallet(wallet.id, wallet.address, network.chainId, wallet.eoaFilters)
              .catch(error => {
                logger.error({ error, walletId: wallet.id, address: wallet.address }, 'Error checking EOA wallet');
              })
          )
        );

        if (chunks.length > 1) {
          await delay(500);
        }
      }
    }
  }

  private async checkEoaWallet(walletId: string, address: string, chainId: number, eoaFilters?: unknown): Promise<void> {
    const lastBlock = await this.getLastProcessedBlock(walletId, chainId);
    const isFirstRun = lastBlock === null;

    if (isFirstRun) {
      const latestBlock = await this.fetchLatestBlockNumber(address, chainId);
      logger.info(
        { walletId, address, chainId, latestBlock },
        'First poll for wallet — recording latest block, skipping history'
      );
      await this.setLastProcessedBlock(walletId, chainId, latestBlock);
      return;
    }

    const startBlock = lastBlock + 1;
    const txs = await this.fetchTransactions(address, chainId, startBlock);
    if (txs.length === 0) return;

    let maxBlock = lastBlock;

    let globalMinValueWei = 0n;
    try {
      globalMinValueWei = BigInt(config.polling.eoaIncomingMinValueWei || '0');
    } catch {
    }

    interface EoaFilters { incoming?: boolean; outgoing?: boolean; contractCalls?: boolean; approvals?: boolean; }
    const filters = eoaFilters as EoaFilters | null;
    const filterIncoming = filters?.incoming ?? true;
    const filterOutgoing = filters?.outgoing ?? true;
    const filterContractCalls = filters?.contractCalls ?? true;
    const filterApprovals = filters?.approvals ?? true;

    for (const tx of txs) {
      const isOutgoing = tx.from.toLowerCase() === address.toLowerCase();
      const isIncoming = tx.to?.toLowerCase() === address.toLowerCase();

      if (isIncoming && !isOutgoing && !filterIncoming) continue;
      if (isOutgoing && !filterOutgoing) continue;

      if (isOutgoing && tx.input && tx.input !== '0x') {
        const isApproval = tx.input.slice(0, 10).toLowerCase() === '0x095ea7b3';
        if (isApproval && !filterApprovals) continue;
        if (!isApproval && !filterContractCalls) continue;
      }

      if (isIncoming && !isOutgoing && globalMinValueWei > 0n) {
        const txValue = BigInt(tx.value || '0');
        if (txValue < globalMinValueWei) {
          logger.debug({ txHash: tx.hash, value: tx.value, minValueWei: globalMinValueWei.toString() }, 'Skipping incoming tx below threshold');
          continue;
        }
      }

      if (isOutgoing || isIncoming) {
        await this.config.onNewTransaction(tx, walletId, address, chainId);
      }
    }

    if (maxBlock > (lastBlock || 0)) {
      await this.setLastProcessedBlock(walletId, chainId, maxBlock);
    }
  }

  private async fetchLatestBlockNumber(address: string, chainId: number): Promise<number> {
    try {
      const response = await axios.get<{
        status: string;
        result: EtherscanTransaction[] | string;
      }>(ETHERSCAN_V2_BASE, {
        params: {
          chainid: chainId,
          module: 'account',
          action: 'txlist',
          address,
          startblock: 0,
          endblock: 99999999,
          page: 1,
          offset: 1,
          sort: 'desc',
          apikey: config.etherscan.apiKey,
        },
        timeout: 15000,
      });

      if (response.data.status === '1' && Array.isArray(response.data.result) && response.data.result.length > 0) {
        return parseInt(response.data.result[0].blockNumber, 10);
      }
    } catch (error) {
      logger.error({ error, address, chainId }, 'Failed to fetch latest block number');
    }

    return 1;
  }

  private async fetchTransactions(
    address: string,
    chainId: number,
    startBlock: number
  ): Promise<EtherscanTransaction[]> {
    try {
      const response = await axios.get<{
        status: string;
        result: EtherscanTransaction[] | string;
      }>(ETHERSCAN_V2_BASE, {
        params: {
          chainid: chainId,
          module: 'account',
          action: 'txlist',
          address,
          startblock: startBlock,
          endblock: 99999999,
          page: 1,
          offset: 100,
          sort: 'asc',
          apikey: config.etherscan.apiKey,
        },
        timeout: 15000,
      });

      if (response.data.status !== '1' || !Array.isArray(response.data.result)) {
        return [];
      }

      return response.data.result;
    } catch (error) {
      logger.error({ error, address, chainId }, 'Failed to fetch EOA transactions from Etherscan');
      return [];
    }
  }

  private async getLastProcessedBlock(walletId: string, chainId: number): Promise<number | null> {
    const key = `${LAST_BLOCK_KEY}:${chainId}:${walletId}`;

    if (isRedisAvailable()) {
      try {
        const val = await redis.get(key);
        return val ? parseInt(val) : null;
      } catch {
      }
    }

    return this.lastBlockMemory.get(key) || null;
  }

  private async setLastProcessedBlock(walletId: string, chainId: number, block: number): Promise<void> {
    const key = `${LAST_BLOCK_KEY}:${chainId}:${walletId}`;
    this.lastBlockMemory.set(key, block);

    if (isRedisAvailable()) {
      try {
        await redis.set(key, block.toString(), 'EX', LAST_BLOCK_TTL);
      } catch {
      }
    }
  }

  async clearWalletState(walletId: string, chainId: number): Promise<void> {
    const key = `${LAST_BLOCK_KEY}:${chainId}:${walletId}`;
    this.lastBlockMemory.delete(key);
    if (isRedisAvailable()) {
      try {
        await redis.del(key);
      } catch {
      }
    }
  }
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
