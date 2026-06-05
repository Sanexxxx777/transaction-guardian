import { Interface } from 'ethers';

const FLUID_ERC4626_ABI = [
  'function deposit(uint256 assets, address receiver) external returns (uint256 shares)',
  'function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares)',
  'function mint(uint256 shares, address receiver) external returns (uint256 assets)',
  'function redeem(uint256 shares, address receiver, address owner) external returns (uint256 assets)',
];

const FLUID_VAULT_ABI = [
  'function operate(uint256 nftId, int256 newCol, int256 newDebt, address to) external returns (uint256, int256, int256)',
];

const fluidErc4626Interface = new Interface(FLUID_ERC4626_ABI);
const fluidVaultInterface = new Interface(FLUID_VAULT_ABI);

export const FLUID_SELECTORS = {
  DEPOSIT: '0x6e553f65',
  WITHDRAW: '0xb460af94',
  MINT: '0x94bf804d',
  REDEEM: '0xba087652',
  OPERATE: '0x032d2276',
} as const;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface FluidDecodeResult {
  protocol: 'FLUID';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isFluidMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(FLUID_SELECTORS).includes(selector as typeof FLUID_SELECTORS[keyof typeof FLUID_SELECTORS]);
}

export function decodeFluid(data: string, safeAddress: string): FluidDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case FLUID_SELECTORS.DEPOSIT: {
        const decoded = fluidErc4626Interface.decodeFunctionData('deposit', data);
        const receiver = decoded[1] as string;
        return { protocol: 'FLUID', method: 'deposit', recipient: receiver, isImplicitSender: false };
      }

      case FLUID_SELECTORS.WITHDRAW: {
        const decoded = fluidErc4626Interface.decodeFunctionData('withdraw', data);
        const receiver = decoded[1] as string;
        return { protocol: 'FLUID', method: 'withdraw', recipient: receiver, isImplicitSender: false };
      }

      case FLUID_SELECTORS.MINT: {
        const decoded = fluidErc4626Interface.decodeFunctionData('mint', data);
        const receiver = decoded[1] as string;
        return { protocol: 'FLUID', method: 'mint', recipient: receiver, isImplicitSender: false };
      }

      case FLUID_SELECTORS.REDEEM: {
        const decoded = fluidErc4626Interface.decodeFunctionData('redeem', data);
        const receiver = decoded[1] as string;
        return { protocol: 'FLUID', method: 'redeem', recipient: receiver, isImplicitSender: false };
      }

      case FLUID_SELECTORS.OPERATE: {
        const decoded = fluidVaultInterface.decodeFunctionData('operate', data);
        const to = decoded[3] as string;

        const isZero = to === ZERO_ADDRESS;
        return {
          protocol: 'FLUID',
          method: 'operate',
          recipient: isZero ? safeAddress : to,
          isImplicitSender: isZero,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
