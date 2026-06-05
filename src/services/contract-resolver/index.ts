import axios from 'axios';
import { redis } from '../../db/redis.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('contract-resolver');

const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';
const SUPPORTED_CHAINS = new Set([1, 42161, 137, 10, 8453, 56, 43114, 59144, 5000, 324]);

const HIT_TTL_SECONDS = 60 * 60 * 24 * 30;
const MISS_TTL_SECONDS = 60 * 60 * 6;

const inflight = new Map<string, Promise<string | null>>();

function cacheKey(chainId: number, address: string): string {
  return `contract_name:${chainId}:${address.toLowerCase()}`;
}

async function fetchFromEtherscan(address: string, chainId: number): Promise<string | null> {
  if (!config.etherscan.apiKey || !SUPPORTED_CHAINS.has(chainId)) return null;
  try {
    const res = await axios.get(ETHERSCAN_V2_URL, {
      params: {
        chainid: chainId,
        module: 'contract',
        action: 'getsourcecode',
        address,
        apikey: config.etherscan.apiKey,
      },
      timeout: 8000,
    });
    if (res.data?.status !== '1' || !Array.isArray(res.data?.result)) return null;
    const entry = res.data.result[0];
    const name = (entry?.ContractName || '').trim();
    return name || null;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err, address, chainId }, 'Etherscan getsourcecode failed');
    return null;
  }
}

export async function resolveContractName(address: string, chainId: number): Promise<string | null> {
  const key = cacheKey(chainId, address);

  try {
    const cached = await redis.get(key);
    if (cached !== null) return cached === '' ? null : cached;
  } catch (err) {
    logger.debug({ err: err instanceof Error ? err.message : err }, 'Redis get failed');
  }

  const flightKey = `${chainId}:${address.toLowerCase()}`;
  const existing = inflight.get(flightKey);
  if (existing) return existing;

  const promise = (async () => {
    const name = await fetchFromEtherscan(address, chainId);
    try {
      await redis.set(key, name || '', 'EX', name ? HIT_TTL_SECONDS : MISS_TTL_SECONDS);
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : err }, 'Redis set failed');
    }
    return name;
  })().finally(() => {
    inflight.delete(flightKey);
  });

  inflight.set(flightKey, promise);
  return promise;
}

export function shortAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
