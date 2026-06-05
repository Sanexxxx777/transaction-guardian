import axios from 'axios';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { redis, isRedisAvailable } from '../../db/redis.js';
import { prisma } from '../../db/index.js';

const logger = createLogger('approval-scanner');

const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';

const MAX_UINT256 = 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';

const CACHE_TTL = 300;

export interface ApprovalEntry {
  tokenAddress: string;
  tokenSymbol: string | null;
  spender: string;
  allowance: string;
  isUnlimited: boolean;
  blockNumber: number;
}

export async function scanApprovals(
  walletAddress: string,
  chainId: number
): Promise<ApprovalEntry[]> {
  const cacheKey = `approvals:${chainId}:${walletAddress.toLowerCase()}`;
  if (isRedisAvailable()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { }
  }

  const network = await prisma.network.findUnique({
    where: { chainId },
    select: { etherscanApiUrl: true },
  });

  if (!network?.etherscanApiUrl || !config.etherscan.apiKey) {
    logger.warn({ chainId }, 'Etherscan API not configured for this chain');
    return [];
  }

  try {
    const ownerTopic = '0x' + walletAddress.toLowerCase().slice(2).padStart(64, '0');
    const RETRY_DELAYS = [2000, 5000, 10000];

    interface EtherscanLogsResponse {
      status: string;
      message: string;
      result: Array<{ address: string; topics: string[]; data: string; blockNumber: string }> | string;
    }
    let response: { data: EtherscanLogsResponse } | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        response = await axios.get(network.etherscanApiUrl, {
          params: {
            module: 'logs',
            action: 'getLogs',
            fromBlock: '0',
            toBlock: 'latest',
            topic0: APPROVAL_TOPIC,
            topic1: ownerTopic,
            topic0_1_opr: 'and',
            apikey: config.etherscan.apiKey,
          },
          timeout: 15000,
        });

        if (response!.data.status === '0' && response!.data.result === 'Max rate limit reached') {
          if (attempt < RETRY_DELAYS.length) {
            logger.warn({ attempt: attempt + 1 }, 'Etherscan rate limit, retrying...');
            await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
            continue;
          }
        }
        break;
      } catch (error) {
        if (attempt < RETRY_DELAYS.length) {
          logger.warn({ attempt: attempt + 1, error }, 'Etherscan request failed, retrying...');
          await new Promise(r => setTimeout(r, RETRY_DELAYS[attempt]));
        } else {
          throw error;
        }
      }
    }

    if (!response || response.data.status !== '1' || !Array.isArray(response.data.result)) {
      if (response?.data.message === 'No records found') return [];
      logger.warn({ status: response?.data.status, message: response?.data.message }, 'Etherscan API error');
      return [];
    }

    const latestApprovals = new Map<string, {
      tokenAddress: string;
      spender: string;
      allowance: string;
      blockNumber: number;
    }>();

    for (const log of response.data.result) {
      const tokenAddress = log.address.toLowerCase();
      const spender = '0x' + (log.topics[2] as string).slice(26).toLowerCase();
      const allowance = (log.data as string).slice(2);
      const blockNumber = parseInt(log.blockNumber, 16);

      const key = `${tokenAddress}:${spender}`;
      const existing = latestApprovals.get(key);

      if (!existing || blockNumber > existing.blockNumber) {
        latestApprovals.set(key, { tokenAddress, spender, allowance, blockNumber });
      }
    }

    const result: ApprovalEntry[] = [];

    for (const entry of latestApprovals.values()) {
      if (/^0+$/.test(entry.allowance)) continue;

      const isUnlimited = entry.allowance.toLowerCase() === MAX_UINT256;

      result.push({
        tokenAddress: entry.tokenAddress,
        tokenSymbol: null,
        spender: entry.spender,
        allowance: entry.allowance,
        isUnlimited,
        blockNumber: entry.blockNumber,
      });
    }

    if (isRedisAvailable()) {
      try {
        await redis.setex(cacheKey, CACHE_TTL, JSON.stringify(result));
      } catch { }
    }

    logger.info({ walletAddress, chainId, count: result.length }, 'Approvals scanned');
    return result;
  } catch (error) {
    logger.error({ error, walletAddress, chainId }, 'Failed to scan approvals');
    return [];
  }
}
