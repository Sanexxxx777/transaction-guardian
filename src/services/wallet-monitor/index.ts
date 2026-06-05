import { prisma, isDatabaseHealthy } from '../../db/index.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { getSafeApiClient, SafeApiClient, RateLimitError } from './safe-api.js';
import { isTransactionProcessed, markTransactionProcessed, getQuotaState, setQuotaState, clearQuotaState } from '../../db/redis.js';
import type { SafeMultisigTransaction, TransactionStatus } from '../../models/transaction.js';

const logger = createLogger('wallet-monitor');

const BACKOFF_INITIAL_MS = 60_000;
const BACKOFF_MAX_MS = 300_000;
const QUOTA_RECHECK_INTERVAL_MS = 6 * 60 * 60_000;
const STATUS_CHECK_INTERVAL = 5;
const DB_UNHEALTHY_BACKOFF_MS = 10_000;

export interface WalletMonitorConfig {
  standbyIntervalMs: number;
  activeIntervalMs: number;
  onNewTransaction: (tx: SafeMultisigTransaction, walletId: string, chainId: number) => Promise<void>;
  onStatusChange: (safeTxHash: string, chainId: number, oldStatus: TransactionStatus, newStatus: TransactionStatus) => Promise<void>;
  onPendingTxDetected?: () => void;
  onQuotaExhausted?: (resetAt: Date) => void;
  onQuotaRestored?: () => void;
}

export class WalletMonitor {
  private config: WalletMonitorConfig;
  private isRunning = false;
  private pollTimer: NodeJS.Timeout | null = null;
  private currentBackoff = 0;
  private pollCount = 0;
  private quotaResetAt: number | null = null;
  private quotaNotifiedExhausted = false;
  private currentIntervalMs: number;

  constructor(config: WalletMonitorConfig) {
    this.config = config;
    this.currentIntervalMs = config.standbyIntervalMs;
  }

  setPollInterval(ms: number): void {
    if (ms === this.currentIntervalMs) return;
    logger.info({ from: this.currentIntervalMs, to: ms }, 'Poll interval changed');
    this.currentIntervalMs = ms;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      logger.warn('WalletMonitor already running');
      return;
    }

    this.isRunning = true;

    const savedState = await getQuotaState();
    if (savedState && savedState.resetAt > Date.now()) {
      this.quotaResetAt = savedState.resetAt;
      this.quotaNotifiedExhausted = savedState.notified;
      logger.info(
        { quotaResetAt: new Date(savedState.resetAt).toISOString(), alreadyNotified: savedState.notified },
        'Restored Safe API quota exhaustion state from Redis'
      );
    }

    logger.info({ intervalMs: this.currentIntervalMs, standby: this.config.standbyIntervalMs, active: this.config.activeIntervalMs }, 'WalletMonitor started');

    await this.poll();
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }
    logger.info('WalletMonitor stopped');
  }

  private async poll(): Promise<void> {
    if (!this.isRunning) return;

    if (!isDatabaseHealthy()) {
      logger.warn('Database unhealthy, skipping poll cycle');
      this.pollTimer = setTimeout(() => this.poll(), DB_UNHEALTHY_BACKOFF_MS);
      return;
    }

    if (this.quotaResetAt) {
      const now = Date.now();
      if (now < this.quotaResetAt) {
        const remainingMs = this.quotaResetAt - now;
        const waitMs = Math.min(remainingMs, QUOTA_RECHECK_INTERVAL_MS);
        const resumeAt = new Date(now + waitMs);
        logger.info(
          { resumeAt: resumeAt.toISOString(), quotaResetAt: new Date(this.quotaResetAt).toISOString(),
            waitMinutes: Math.round(waitMs / 60_000) },
          'Safe API quota exhausted — sleeping until reset or next recheck'
        );
        this.pollTimer = setTimeout(() => this.poll(), waitMs);
        return;
      }

      logger.info('Quota reset time reached, attempting to resume Safe API monitoring');
    }

    this.pollCount++;
    const shouldCheckStatus = this.pollCount % STATUS_CHECK_INTERVAL === 0;

    try {
      await this.checkAllWallets(shouldCheckStatus);
      this.currentBackoff = 0;

      if (this.quotaResetAt) {
        logger.info('Safe API quota restored — normal monitoring resumed');
        this.quotaResetAt = null;
        this.quotaNotifiedExhausted = false;
        clearQuotaState().catch(() => {});
        try { this.config.onQuotaRestored?.(); } catch {}
      }
    } catch (error) {
      if (error instanceof RateLimitError) {
        this.handleRateLimitError(error);

        if (error.rateLimitInfo.isMonthlyQuota) return;
      } else if (this.isRateLimitError(error)) {
        this.currentBackoff = this.currentBackoff === 0
          ? BACKOFF_INITIAL_MS
          : Math.min(this.currentBackoff * 2, BACKOFF_MAX_MS);
        logger.warn({ backoffMs: this.currentBackoff }, 'Rate limited (fallback handling)');
      } else {
        logger.error({ error }, 'Error during poll cycle');
      }
    }

    if (!this.isRunning) return;

    const nextPollMs = this.currentIntervalMs + this.currentBackoff;
    this.pollTimer = setTimeout(() => this.poll(), nextPollMs);
  }

  private handleRateLimitError(error: RateLimitError): void {
    const { isMonthlyQuota, resetSeconds, remaining } = error.rateLimitInfo;

    if (isMonthlyQuota && resetSeconds > 0) {
      this.quotaResetAt = Date.now() + (resetSeconds * 1000);
      const resetDate = new Date(this.quotaResetAt);
      const waitMs = Math.min(resetSeconds * 1000, QUOTA_RECHECK_INTERVAL_MS);

      logger.error(
        { quotaResetAt: resetDate.toISOString(), remaining, nextCheckMinutes: Math.round(waitMs / 60_000) },
        'Safe API monthly quota exhausted — auto-recovery scheduled'
      );

      if (!this.quotaNotifiedExhausted) {
        this.quotaNotifiedExhausted = true;
        try { this.config.onQuotaExhausted?.(resetDate); } catch {}
      }

      setQuotaState({ resetAt: this.quotaResetAt, notified: this.quotaNotifiedExhausted }).catch(() => {});

      this.pollTimer = setTimeout(() => this.poll(), waitMs);
    } else if (resetSeconds > 0) {
      this.currentBackoff = Math.min(resetSeconds * 1000 + 5000, BACKOFF_MAX_MS);
      logger.warn({ backoffMs: this.currentBackoff, resetSeconds }, 'Safe API temporary rate limit');
    } else {
      this.currentBackoff = this.currentBackoff === 0
        ? BACKOFF_INITIAL_MS
        : Math.min(this.currentBackoff * 2, BACKOFF_MAX_MS);
      logger.warn({ backoffMs: this.currentBackoff }, 'Safe API rate limited — exponential backoff');
    }
  }

  private isRateLimitError(error: unknown): boolean {
    if (error instanceof RateLimitError) return true;
    if (error && typeof error === 'object' && 'response' in error) {
      const axiosError = error as { response?: { status?: number } };
      return axiosError.response?.status === 429;
    }
    if (error && typeof error === 'object' && 'message' in error) {
      const msgError = error as { message: string };
      return msgError.message.includes('429');
    }
    return false;
  }

  private async checkAllWallets(shouldCheckStatus: boolean): Promise<void> {
    let networks: Awaited<ReturnType<typeof prisma.network.findMany>>;
    let wallets: Awaited<ReturnType<typeof prisma.wallet.findMany>>;

    try {
      networks = await prisma.network.findMany({ where: { isEnabled: true } });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch networks from DB, skipping cycle');
      return;
    }

    try {
      wallets = await prisma.wallet.findMany({
        where: { isActive: true, type: 'safe' },
        include: { client: true },
      });
    } catch (error) {
      logger.error({ error }, 'Failed to fetch wallets from DB, skipping cycle');
      return;
    }

    const walletsByChain = new Map<number, typeof wallets>();
    for (const wallet of wallets) {
      const existing = walletsByChain.get(wallet.chainId) || [];
      existing.push(wallet);
      walletsByChain.set(wallet.chainId, existing);
    }

    const networkResults = await Promise.allSettled(
      networks
        .filter(n => walletsByChain.has(n.chainId))
        .map(network => this.checkNetworkWallets(network, walletsByChain.get(network.chainId)!, shouldCheckStatus))
    );

    for (const result of networkResults) {
      if (result.status === 'rejected' && this.isRateLimitError(result.reason)) {
        throw result.reason;
      }
    }
  }

  private async checkNetworkWallets(
    network: { chainId: number; safeTxServiceUrl: string },
    chainWallets: Array<{ id: string; address: string; chainId: number }>,
    shouldCheckStatus: boolean
  ): Promise<void> {
    const client = getSafeApiClient(network.chainId, network.safeTxServiceUrl, config.safe.apiKey);

    for (const wallet of chainWallets) {
      try {
        await this.checkWallet(wallet.id, wallet.address, network.chainId, client, shouldCheckStatus);
        await this.delay(200);
      } catch (error) {
        if (this.isRateLimitError(error)) throw error;
        logger.error(
          { error, walletId: wallet.id, address: wallet.address, chainId: network.chainId },
          'Error checking wallet'
        );
      }
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async checkWallet(
    walletId: string,
    address: string,
    chainId: number,
    client: SafeApiClient,
    shouldCheckStatus: boolean
  ): Promise<void> {
    const pendingTxs = await client.getPendingTransactions(address);
    const pendingOnSafe = new Set(pendingTxs.map(tx => tx.safeTxHash));

    for (const tx of pendingTxs) {
      const alreadyProcessed = await isTransactionProcessed(tx.safeTxHash, chainId);

      if (!alreadyProcessed) {
        const isFirstMarker = await markTransactionProcessed(tx.safeTxHash, chainId);
        if (!isFirstMarker) continue;

        const existsInDb = await prisma.transactionHistory.findUnique({
          where: { safeTxHash_chainId: { safeTxHash: tx.safeTxHash, chainId } },
          select: { id: true },
        });
        if (existsInDb) continue;

        logger.info(
          { safeTxHash: tx.safeTxHash, chainId, address },
          'New pending transaction detected'
        );

        try { this.config.onPendingTxDetected?.(); } catch {}

        await this.config.onNewTransaction(tx, walletId, chainId);
      }

      await this.checkStatusChange(tx, chainId);
    }

    if (shouldCheckStatus) {
      await this.checkExecutedTransactions(walletId, chainId, pendingOnSafe, client);
    }
  }

  private async checkStatusChange(tx: SafeMultisigTransaction, chainId: number): Promise<void> {
    const existing = await prisma.transactionHistory.findUnique({
      where: { safeTxHash_chainId: { safeTxHash: tx.safeTxHash, chainId } },
    });

    if (!existing) return;

    const newStatus = this.determineStatus(tx);
    const oldStatus = existing.status as TransactionStatus;

    if (newStatus !== oldStatus) {
      logger.info({ safeTxHash: tx.safeTxHash, chainId, oldStatus, newStatus }, 'Transaction status changed');
      await this.config.onStatusChange(tx.safeTxHash, chainId, oldStatus, newStatus);
    }
  }

  private async checkExecutedTransactions(
    walletId: string,
    chainId: number,
    pendingOnSafe: Set<string>,
    client: ReturnType<typeof getSafeApiClient>
  ): Promise<void> {
    const pendingInDb = await prisma.transactionHistory.findMany({
      where: { walletId, chainId, status: { in: ['pending', 'signed'] } },
    });

    for (const dbTx of pendingInDb) {
      if (!dbTx.safeTxHash || !pendingOnSafe.has(dbTx.safeTxHash)) {
        if (!dbTx.safeTxHash) continue;

        logger.info(
          { safeTxHash: dbTx.safeTxHash, chainId },
          'Transaction no longer pending on Safe API, checking actual status'
        );

        try {
          const fullTx = await client.getTransaction(dbTx.safeTxHash);

          if (!fullTx) {
            await this.config.onStatusChange(dbTx.safeTxHash, chainId, dbTx.status as TransactionStatus, 'rejected');
            continue;
          }

          let newStatus: TransactionStatus;
          if (fullTx.isExecuted) {
            newStatus = fullTx.isSuccessful ? 'executed' : 'failed';
          } else {
            newStatus = 'rejected';
          }

          if (newStatus !== dbTx.status) {
            await this.config.onStatusChange(dbTx.safeTxHash, chainId, dbTx.status as TransactionStatus, newStatus);
          }
        } catch (error) {
          logger.error(
            { error, safeTxHash: dbTx.safeTxHash, chainId },
            'Failed to check transaction status via Safe API'
          );
        }
      }
    }
  }

  private determineStatus(tx: SafeMultisigTransaction): TransactionStatus {
    if (tx.isExecuted) {
      return tx.isSuccessful ? 'executed' : 'failed';
    }

    if ((tx.confirmations?.length || 0) >= tx.confirmationsRequired) {
      return 'signed';
    }

    return 'pending';
  }
}
