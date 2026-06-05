
const DEPOSIT_V3 = '0x7b939232';

const DEPOSIT = '0xd2645d20';

const DEPOSIT_BYTES32 = '0xad5425c6';

const DEPOSIT_NATIVE = '0x656a20e6';

const SWAP_AND_BRIDGE = '0x13eb1e6f';

const ALL_SELECTORS = [DEPOSIT_V3, DEPOSIT, DEPOSIT_BYTES32, DEPOSIT_NATIVE, SWAP_AND_BRIDGE];

const PERIPHERY_ADDRESSES = new Set([
  '0x89415a82d909a7238d69094c3dd1dcc1acbda85c',
]);

export interface AcrossDecodeResult {
  protocol: 'Across';
  method: string;
  recipient: string | null;
  destinationChainId: number | null;
  isImplicitSender: boolean;
}

export function isAcrossMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return ALL_SELECTORS.includes(selector);
}

export function isAcrossContract(to: string): boolean {
  return PERIPHERY_ADDRESSES.has(to.toLowerCase());
}

function extractAddress(hexData: string, paramIndex: number): string | null {
  try {
    const hex = hexData.startsWith('0x') ? hexData.slice(2) : hexData;

    const offset = 8 + paramIndex * 64;
    if (hex.length < offset + 64) return null;
    const word = hex.slice(offset, offset + 64);

    const addr = '0x' + word.slice(24);

    if (addr === '0x0000000000000000000000000000000000000000') return null;
    return addr;
  } catch {
    return null;
  }
}

function extractUint(hexData: string, paramIndex: number): bigint | null {
  try {
    const hex = hexData.startsWith('0x') ? hexData.slice(2) : hexData;
    const offset = 8 + paramIndex * 64;
    if (hex.length < offset + 64) return null;
    const word = hex.slice(offset, offset + 64);
    return BigInt('0x' + word);
  } catch {
    return null;
  }
}

export function decodeAcross(data: string, safeAddress: string): AcrossDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case DEPOSIT_V3:
      case DEPOSIT:
      case DEPOSIT_BYTES32: {
        const recipient = extractAddress(data, 1);
        const destChainRaw = extractUint(data, 6);
        const destChainId = destChainRaw ? Number(destChainRaw) : null;
        const methodName = selector === DEPOSIT_V3
          ? 'depositV3'
          : selector === DEPOSIT
          ? 'deposit'
          : 'deposit';
        return {
          protocol: 'Across',
          method: methodName,
          recipient,
          destinationChainId: destChainId,
          isImplicitSender: false,
        };
      }

      case DEPOSIT_NATIVE: {
        const recipient = extractAddress(data, 1);
        const destChainRaw = extractUint(data, 6);
        const destChainId = destChainRaw ? Number(destChainRaw) : null;
        return {
          protocol: 'Across',
          method: 'depositNative',
          recipient,
          destinationChainId: destChainId,
          isImplicitSender: false,
        };
      }

      case SWAP_AND_BRIDGE: {
        let destChainId: number | null = null;
        const hex = data.startsWith('0x') ? data.slice(2) : data;

        for (let wi = 8; wi < 20 && 8 + wi * 64 + 64 <= hex.length; wi++) {
          const wordVal = extractUint(data, wi);
          if (wordVal !== null) {
            const num = Number(wordVal);

            if (num > 0 && num < 10_000_000 && [1, 10, 56, 137, 8453, 42161, 43114, 59144, 5000, 324, 34443, 534352, 7777777].includes(num)) {
              destChainId = num;
              break;
            }
          }
        }
        return {
          protocol: 'Across',
          method: 'swapAndBridge',
          recipient: safeAddress,
          destinationChainId: destChainId,
          isImplicitSender: true,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
