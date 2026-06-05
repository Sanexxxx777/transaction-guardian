import { createLogger } from '../../utils/logger.js';

const logger = createLogger('bridge-decoder');

const LIFI_CONTRACTS = new Set([
  '0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae',
]);

const SOCKET_CONTRACTS = new Set([
  '0x3a23f943181408eac424116af7b7790c94cb97a5',
]);

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  137: 'Polygon',
  8453: 'Base',
  42161: 'Arbitrum One',
  43114: 'Avalanche',
  59144: 'Linea',
  5000: 'Mantle',
  324: 'zkSync Era',
  34443: 'Mode',
  534352: 'Scroll',
  7777777: 'Zora',
};

export interface BridgeDecodeResult {
  protocol: string;
  method: string;
  destinationChainId: number | null;
  destinationChainName: string | null;
  receiver: string | null;
}

export function isBridgeAggregator(to: string): boolean {
  const addr = to.toLowerCase();
  return LIFI_CONTRACTS.has(addr) || SOCKET_CONTRACTS.has(addr);
}

export function decodeBridge(to: string, data: string): BridgeDecodeResult | null {
  const addr = to.toLowerCase();

  if (LIFI_CONTRACTS.has(addr)) {
    return decodeLiFi(data);
  }

  if (SOCKET_CONTRACTS.has(addr)) {
    return { protocol: 'Socket (Bungee)', method: 'Bridge', destinationChainId: null, destinationChainName: null, receiver: null };
  }

  return null;
}

function decodeLiFi(data: string): BridgeDecodeResult | null {
  try {
    const hex = data.startsWith('0x') ? data.slice(2) : data;
    if (hex.length < 8 + 64 * 9) return fallbackLiFi();

    const paramStart = 8;

    const bridgeDataOffset = parseInt(hex.slice(paramStart, paramStart + 64), 16);

    const bdStart = paramStart + bridgeDataOffset * 2;

    if (bdStart + 8 * 64 > hex.length) return fallbackLiFi();

    const receiverWord = hex.slice(bdStart + 5 * 64, bdStart + 6 * 64);
    const receiver = '0x' + receiverWord.slice(24);

    const chainIdHex = hex.slice(bdStart + 7 * 64, bdStart + 8 * 64);
    const destinationChainId = parseInt(chainIdHex, 16);

    if (destinationChainId <= 0 || !Number.isFinite(destinationChainId)) {
      return fallbackLiFi();
    }

    const destinationChainName = CHAIN_NAMES[destinationChainId] || `Chain ${destinationChainId}`;

    logger.debug({ destinationChainId, destinationChainName, receiver }, 'LI.FI bridge decoded');

    return {
      protocol: 'Jumper (LI.FI)',
      method: 'Bridge',
      destinationChainId,
      destinationChainName,
      receiver,
    };
  } catch (err) {
    logger.debug({ err }, 'Failed to decode LI.FI bridge data');
    return fallbackLiFi();
  }
}

function fallbackLiFi(): BridgeDecodeResult {
  return { protocol: 'Jumper (LI.FI)', method: 'Bridge', destinationChainId: null, destinationChainName: null, receiver: null };
}
