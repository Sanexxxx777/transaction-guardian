import { Redis } from 'ioredis';
import { config } from '../config/index.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('redis');

const memoryDedupCache = new Map<string, number>();
const MEMORY_DEDUP_MAX_SIZE = 10000;
let redisAvailable = true;

export const redis = new Redis(config.redis.url, {
  maxRetriesPerRequest: 3,
  retryStrategy(times: number) {
    const delay = Math.min(times * 200, 5000);
    logger.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting...');
    return delay;
  },
  reconnectOnError(err: Error) {
    const targetErrors = ['READONLY', 'ECONNRESET', 'ETIMEDOUT'];
    return targetErrors.some(e => err.message.includes(e));
  },
});

redis.on('connect', () => {
  redisAvailable = true;
  logger.info('Redis connected');
});

redis.on('ready', () => {
  redisAvailable = true;
});

redis.on('error', (error: Error) => {
  logger.error({ error }, 'Redis error');
});

redis.on('close', () => {
  redisAvailable = false;
  logger.warn('Redis connection closed');
});

export function isRedisAvailable(): boolean {
  return redisAvailable;
}

function cleanMemoryDedup(): void {
  if (memoryDedupCache.size < MEMORY_DEDUP_MAX_SIZE) return;

  const now = Date.now();
  const ttlMs = PROCESSED_TX_TTL * 1000;

  for (const [key, ts] of memoryDedupCache) {
    if (now - ts > ttlMs) {
      memoryDedupCache.delete(key);
    }
  }

  const targetSize = Math.floor(MEMORY_DEDUP_MAX_SIZE * 0.8);
  if (memoryDedupCache.size > targetSize) {
    const entries = Array.from(memoryDedupCache.entries()).sort((a, b) => a[1] - b[1]);
    const toRemove = memoryDedupCache.size - targetSize;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      memoryDedupCache.delete(entries[i][0]);
    }
  }
}

const PROCESSED_TX_KEY = 'processed_tx';
const PROCESSED_TX_TTL = 60 * 60 * 24 * 7;

export async function isTransactionProcessed(safeTxHash: string, chainId: number): Promise<boolean> {
  const key = `${PROCESSED_TX_KEY}:${chainId}:${safeTxHash}`;

  if (!redisAvailable) {
    return memoryDedupCache.has(key);
  }

  try {
    const exists = await redis.exists(key);
    return exists === 1;
  } catch {
    return memoryDedupCache.has(key);
  }
}

export async function markTransactionProcessed(safeTxHash: string, chainId: number): Promise<boolean> {
  const key = `${PROCESSED_TX_KEY}:${chainId}:${safeTxHash}`;

  const wasInMemory = memoryDedupCache.has(key);
  memoryDedupCache.set(key, Date.now());
  cleanMemoryDedup();

  if (!redisAvailable) {
    return !wasInMemory;
  }

  try {
    const result = await redis.set(key, '1', 'EX', PROCESSED_TX_TTL, 'NX');
    return result === 'OK';
  } catch {
    logger.debug({ key }, 'Failed to mark in Redis, using memory fallback');
    return !wasInMemory;
  }
}

const PRICE_CACHE_KEY = 'price';

export async function getCachedPrice(tokenId: string): Promise<number | null> {
  if (!redisAvailable) return null;
  try {
    const key = `${PRICE_CACHE_KEY}:${tokenId}`;
    const cached = await redis.get(key);
    return cached ? parseFloat(cached) : null;
  } catch {
    return null;
  }
}

export async function setCachedPrice(tokenId: string, price: number): Promise<void> {
  if (!redisAvailable) return;
  try {
    const key = `${PRICE_CACHE_KEY}:${tokenId}`;
    await redis.setex(key, config.polling.priceCacheTtlSeconds, price.toString());
  } catch {
  }
}

export async function getCachedPrices(tokenIds: string[]): Promise<Record<string, number | null>> {
  if (tokenIds.length === 0) return {};
  if (!redisAvailable) return Object.fromEntries(tokenIds.map(id => [id, null]));

  try {
    const keys = tokenIds.map(id => `${PRICE_CACHE_KEY}:${id}`);
    const values = await redis.mget(...keys);

    const result: Record<string, number | null> = {};
    for (let i = 0; i < tokenIds.length; i++) {
      result[tokenIds[i]] = values[i] ? parseFloat(values[i]!) : null;
    }
    return result;
  } catch {
    return Object.fromEntries(tokenIds.map(id => [id, null]));
  }
}

export async function setCachedPrices(prices: Record<string, number>): Promise<void> {
  const entries = Object.entries(prices);
  if (entries.length === 0) return;
  if (!redisAvailable) return;

  try {
    const pipeline = redis.pipeline();
    for (const [tokenId, price] of entries) {
      const key = `${PRICE_CACHE_KEY}:${tokenId}`;
      pipeline.setex(key, config.polling.priceCacheTtlSeconds, price.toString());
    }
    await pipeline.exec();
  } catch {
  }
}

const RATE_LIMIT_KEY = 'rate_limit';

export async function checkRateLimit(key: string, maxRequests: number, windowSeconds: number): Promise<boolean> {
  if (!redisAvailable) return true;

  try {
    const redisKey = `${RATE_LIMIT_KEY}:${key}`;
    const current = await redis.incr(redisKey);

    if (current === 1) {
      await redis.expire(redisKey, windowSeconds);
    }

    return current <= maxRequests;
  } catch {
    return true;
  }
}

const QUOTA_STATE_KEY = 'safe_api:quota_state';

export interface QuotaState {
  resetAt: number;
  notified: boolean;
}

export async function getQuotaState(): Promise<QuotaState | null> {
  if (!redisAvailable) return null;
  try {
    const raw = await redis.get(QUOTA_STATE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function setQuotaState(state: QuotaState): Promise<void> {
  if (!redisAvailable) return;
  try {
    const ttl = Math.max(Math.ceil((state.resetAt - Date.now()) / 1000) + 86400, 3600);
    await redis.setex(QUOTA_STATE_KEY, ttl, JSON.stringify(state));
  } catch {
  }
}

export async function clearQuotaState(): Promise<void> {
  if (!redisAvailable) return;
  try {
    await redis.del(QUOTA_STATE_KEY);
  } catch {
  }
}

export async function disconnectRedis(): Promise<void> {
  await redis.quit();
  logger.info('Redis disconnected');
}
