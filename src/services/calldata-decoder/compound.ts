import { Interface } from 'ethers';

const COMPOUND_COMET_ABI = [
  'function supply(address asset, uint256 amount) external',
  'function supplyTo(address dst, address asset, uint256 amount) external',
  'function withdraw(address asset, uint256 amount) external',
  'function withdrawTo(address to, address asset, uint256 amount) external',
];

const COMPOUND_BULKER_ABI = [
  'function invoke(bytes32[] actions, bytes[] data) external payable',
];

const compoundCometInterface = new Interface(COMPOUND_COMET_ABI);

export const COMPOUND_SELECTORS = {
  SUPPLY: '0xf2b9fdb8',
  SUPPLY_TO: '0x4232cd63',
  WITHDRAW: '0xf3fef3a3',
  WITHDRAW_TO: '0xc3b35a7e',

  INVOKE: '0xdb6a7451',
} as const;

export interface CompoundDecodeResult {
  protocol: 'Compound';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isCompoundMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(COMPOUND_SELECTORS).includes(selector as typeof COMPOUND_SELECTORS[keyof typeof COMPOUND_SELECTORS]);
}

export function decodeCompound(data: string, safeAddress: string): CompoundDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case COMPOUND_SELECTORS.SUPPLY: {
        return {
          protocol: 'Compound',
          method: 'supply',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case COMPOUND_SELECTORS.SUPPLY_TO: {
        const decoded = compoundCometInterface.decodeFunctionData('supplyTo', data);
        const dst = decoded[0] as string;
        return {
          protocol: 'Compound',
          method: 'supplyTo',
          recipient: dst,
          isImplicitSender: false,
        };
      }

      case COMPOUND_SELECTORS.WITHDRAW: {
        return {
          protocol: 'Compound',
          method: 'withdraw',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case COMPOUND_SELECTORS.WITHDRAW_TO: {
        const decoded = compoundCometInterface.decodeFunctionData('withdrawTo', data);
        const to = decoded[0] as string;
        return {
          protocol: 'Compound',
          method: 'withdrawTo',
          recipient: to,
          isImplicitSender: false,
        };
      }

      case COMPOUND_SELECTORS.INVOKE: {
        return {
          protocol: 'Compound',
          method: 'invoke',
          recipient: safeAddress,
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
