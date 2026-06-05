import axios, { AxiosInstance, AxiosError } from 'axios';
import { createLogger } from '../../utils/logger.js';
import type { SafeMultisigTransaction } from '../../models/transaction.js';

const logger = createLogger('safe-api');

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetSeconds: number;
  isMonthlyQuota: boolean;
}

export class RateLimitError extends Error {
  public rateLimitInfo: RateLimitInfo;
  constructor(message: string, info: RateLimitInfo) {
    super(message);
    this.name = 'RateLimitError';
    this.rateLimitInfo = info;
  }
}

export interface SafeApiConfig {
  baseUrl: string;
  chainId: number;
  apiKey?: string;
}

export class SafeApiClient {
  private client: AxiosInstance;
  private chainId: number;

  constructor(config: SafeApiConfig) {
    this.chainId = config.chainId;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'User-Agent': 'TransactionGuardian/2.0',
    };
    if (config.apiKey) {
      headers['Authorization'] = `Bearer ${config.apiKey}`;
      logger.info({ chainId: config.chainId }, 'Safe API client initialized with API key');
    }
    this.client = axios.create({
      baseURL: config.baseUrl,
      timeout: 15000,
      maxRedirects: 3,
      headers,
    });
  }

  async getPendingTransactions(safeAddress: string): Promise<SafeMultisigTransaction[]> {
    return this.withRetry(async () => {
      const LIMIT = 100;
      const response = await this.client.get<{
        count: number;
        results: SafeMultisigTransaction[];
      }>(`/api/v1/safes/${safeAddress}/multisig-transactions/`, {
        params: {
          executed: false,
          limit: LIMIT,
        },
      });

      if (response.data.count > LIMIT) {
        logger.warn(
          { safeAddress, count: response.data.count, limit: LIMIT },
          'Safe has more pending transactions than fetch limit — some may be missed'
        );
      }

      return response.data.results;
    }, 'getPendingTransactions', { safeAddress });
  }

  async getTransactions(
    safeAddress: string,
    options: { limit?: number; offset?: number; executed?: boolean } = {}
  ): Promise<{ count: number; results: SafeMultisigTransaction[] }> {
    return this.withRetry(async () => {
      const response = await this.client.get<{
        count: number;
        next: string | null;
        previous: string | null;
        results: SafeMultisigTransaction[];
      }>(`/api/v1/safes/${safeAddress}/multisig-transactions/`, {
        params: {
          limit: options.limit ?? 20,
          offset: options.offset ?? 0,
          executed: options.executed,
        },
      });

      return {
        count: response.data.count,
        results: response.data.results,
      };
    }, 'getTransactions', { safeAddress });
  }

  async getTransaction(safeTxHash: string): Promise<SafeMultisigTransaction | null> {
    try {
      return await this.withRetry(async () => {
        const response = await this.client.get<SafeMultisigTransaction>(
          `/api/v1/multisig-transactions/${safeTxHash}/`
        );
        return response.data;
      }, 'getTransaction', { safeTxHash });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  async getSafeInfo(safeAddress: string): Promise<SafeInfo | null> {
    try {
      return await this.withRetry(async () => {
        const response = await this.client.get<SafeInfo>(`/api/v1/safes/${safeAddress}/`);
        return response.data;
      }, 'getSafeInfo', { safeAddress });
    } catch (error) {
      if (axios.isAxiosError(error) && error.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    method: string,
    context: Record<string, string>
  ): Promise<T> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 429) {
          const info = this.parseRateLimitHeaders(error);
          logger.warn({ ...context, chainId: this.chainId, ...info }, `Rate limited on ${method}`);
          throw new RateLimitError(
            `Safe API rate limit: ${info.isMonthlyQuota ? 'monthly quota exceeded' : 'temporary'}`,
            info
          );
        }

        const isLast = attempt === maxAttempts;
        if (isLast || !this.isRetryableError(error)) {
          logger.error({ error, ...context, chainId: this.chainId, attempt }, `Failed ${method}`);
          throw error;
        }
        const delay = 1000 * Math.pow(2, attempt - 1);
        logger.warn({ ...context, chainId: this.chainId, attempt, delay }, `Retrying ${method}`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
    throw new Error('unreachable');
  }

  private parseRateLimitHeaders(error: AxiosError): RateLimitInfo {
    const headers = error.response?.headers || {};
    const limit = parseInt(String(headers['x-ratelimit-limit'] || '0'), 10);
    const remaining = parseInt(String(headers['x-ratelimit-remaining'] || '0'), 10);
    const resetSeconds = parseInt(String(headers['x-ratelimit-reset'] || '0'), 10);
    const bodyMsg = typeof error.response?.data === 'object' && error.response?.data !== null
      ? (error.response.data as { error_msg?: string }).error_msg || ''
      : '';
    const isMonthlyQuota = bodyMsg.toLowerCase().includes('monthly quota')
      || (resetSeconds > 86400);

    return { limit, remaining, resetSeconds, isMonthlyQuota };
  }

  private isRetryableError(error: unknown): boolean {
    if (!axios.isAxiosError(error)) return false;
    const e = error as AxiosError;
    const code = e.code;
    if (code === 'ECONNABORTED' || code === 'ETIMEDOUT' || code === 'ECONNRESET') return true;
    const status = e.response?.status;

    if (status && status >= 500) return true;
    return false;
  }
}

export interface SafeInfo {
  address: string;
  nonce: number;
  threshold: number;
  owners: string[];
  masterCopy: string;
  modules: string[];
  fallbackHandler: string;
  guard: string;
  version: string;
}

const clientCache = new Map<number, SafeApiClient>();

export function getSafeApiClient(chainId: number, baseUrl: string, apiKey?: string): SafeApiClient {
  const existing = clientCache.get(chainId);
  if (existing) {
    return existing;
  }

  const client = new SafeApiClient({ chainId, baseUrl, apiKey });
  clientCache.set(chainId, client);
  return client;
}
