import { prisma } from '../../db/index.js';
import { lookupToken as staticLookup } from '../cow-orderbook/tokens.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('token-resolver');

export interface ResolvedToken {
  symbol: string;
  decimals: number;
  source: 'static' | 'manual';
}

export async function resolveToken(chainId: number, address: string): Promise<ResolvedToken | null> {
  const lower = address.toLowerCase();

  const staticHit = staticLookup(chainId, address);
  if (staticHit) return { ...staticHit, source: 'static' };

  try {
    const dbHit = await prisma.token.findUnique({
      where: { chainId_address: { chainId, address: lower } },
    });
    if (dbHit) {
      return { symbol: dbHit.symbol, decimals: dbHit.decimals, source: 'manual' };
    }
  } catch (error) {
    logger.warn({ error, chainId, address: lower }, 'DB lookup failed during token resolve');
  }

  return null;
}

export async function setManualToken(
  chainId: number,
  address: string,
  symbol: string,
  decimals: number,
): Promise<void> {
  const lower = address.toLowerCase();
  await prisma.token.upsert({
    where: { chainId_address: { chainId, address: lower } },
    create: { chainId, address: lower, symbol, decimals, source: 'manual' },
    update: { symbol, decimals, source: 'manual' },
  });
  logger.info({ chainId, address: lower, symbol, decimals }, 'Manual token registered');
}
