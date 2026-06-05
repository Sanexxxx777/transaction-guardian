import axios from 'axios';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { getCachedPrice, setCachedPrice, getCachedPrices, setCachedPrices } from '../../db/redis.js';

const logger = createLogger('price-fetcher');

const COINGECKO_BASE_URL = 'https://api.coingecko.com/api/v3';

export const TOKEN_COINGECKO_IDS: Record<string, string> = {
  'USDC': 'usd-coin',
  'USDT': 'tether',
  'DAI': 'dai',
  'FRAX': 'frax',
  'LUSD': 'liquity-usd',

  'WETH': 'weth',
  'ETH': 'ethereum',
  'WBTC': 'wrapped-bitcoin',
  'BTC': 'bitcoin',
  'LINK': 'chainlink',
  'UNI': 'uniswap',
  'AAVE': 'aave',
  'MKR': 'maker',
  'CRV': 'curve-dao-token',
  'LDO': 'lido-dao',
  'stETH': 'staked-ether',
  'wstETH': 'wrapped-steth',
  'cbETH': 'coinbase-wrapped-staked-eth',
  'rETH': 'rocket-pool-eth',

  'ARB': 'arbitrum',
  'OP': 'optimism',
  'MATIC': 'matic-network',

  'BNB': 'binancecoin',
  'AVAX': 'avalanche-2',
};

export class PriceFetcher {
  private apiKey: string | undefined;

  private inflight = new Map<string, Promise<number | null>>();

  constructor() {
    this.apiKey = config.coingecko.apiKey;
  }

  async getPrice(symbol: string): Promise<number | null> {
    const coingeckoId = TOKEN_COINGECKO_IDS[symbol.toUpperCase()];
    if (!coingeckoId) {
      logger.debug({ symbol }, 'Unknown token symbol, no coingecko ID');
      return null;
    }

    return this.getPriceById(coingeckoId);
  }

  async getPriceById(coingeckoId: string): Promise<number | null> {
    const cached = await getCachedPrice(coingeckoId);
    if (cached !== null) {
      return cached;
    }

    const existing = this.inflight.get(coingeckoId);
    if (existing) return existing;

    const promise = this._fetchPrice(coingeckoId).finally(() => {
      this.inflight.delete(coingeckoId);
    });
    this.inflight.set(coingeckoId, promise);
    return promise;
  }

  private async _fetchPrice(coingeckoId: string): Promise<number | null> {
    try {
      const params: Record<string, string> = {
        ids: coingeckoId,
        vs_currencies: 'usd',
      };

      if (this.apiKey) {
        params.x_cg_demo_api_key = this.apiKey;
      }

      const response = await axios.get<Record<string, { usd: number }>>(
        `${COINGECKO_BASE_URL}/simple/price`,
        { params, timeout: 10000 }
      );

      const price = response.data[coingeckoId]?.usd;
      if (price === undefined) {
        logger.warn({ coingeckoId }, 'Price not found in response');
        return null;
      }

      await setCachedPrice(coingeckoId, price);

      return price;
    } catch (error) {
      logger.error({ error, coingeckoId }, 'Failed to fetch price');
      return null;
    }
  }

  async getPrices(coingeckoIds: string[]): Promise<Record<string, number>> {
    const result: Record<string, number> = {};
    if (coingeckoIds.length === 0) return result;

    const cached = await getCachedPrices(coingeckoIds);
    const toFetch: string[] = [];

    for (const id of coingeckoIds) {
      if (cached[id] !== null && cached[id] !== undefined) {
        result[id] = cached[id]!;
      } else {
        toFetch.push(id);
      }
    }

    if (toFetch.length === 0) {
      return result;
    }

    try {
      const params: Record<string, string> = {
        ids: toFetch.join(','),
        vs_currencies: 'usd',
      };

      if (this.apiKey) {
        params.x_cg_demo_api_key = this.apiKey;
      }

      const response = await axios.get<Record<string, { usd: number }>>(
        `${COINGECKO_BASE_URL}/simple/price`,
        { params, timeout: 10000 }
      );

      const toCache: Record<string, number> = {};
      for (const [id, data] of Object.entries(response.data)) {
        if (data.usd !== undefined) {
          result[id] = data.usd;
          toCache[id] = data.usd;
        }
      }
      await setCachedPrices(toCache);
    } catch (error) {
      logger.error({ error, ids: toFetch }, 'Failed to fetch prices');
    }

    return result;
  }

  async toUsd(symbol: string, amount: number): Promise<number | null> {
    if (['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD'].includes(symbol.toUpperCase())) {
      return amount;
    }

    const price = await this.getPrice(symbol);
    if (price === null) return null;

    return amount * price;
  }
}

let priceFetcher: PriceFetcher | null = null;

export function getPriceFetcher(): PriceFetcher {
  if (!priceFetcher) {
    priceFetcher = new PriceFetcher();
  }
  return priceFetcher;
}
