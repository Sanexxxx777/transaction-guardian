import { Interface } from 'ethers';

const KELP_DEPOSIT_POOL_ABI = [
  'function depositAsset(address asset, uint256 depositAmount) external',

  'function depositAsset(address asset, uint256 depositAmount, uint256 minRSETHAmountExpected, string referralId) external',

  'function depositETH(uint256 minRSETHAmountExpected, string referralId) external payable',
];

const kelpDepositPoolInterface = new Interface(KELP_DEPOSIT_POOL_ABI);

export const KELP_SELECTORS = {
  DEPOSIT_ASSET_V1: '0x46a5d043',
  DEPOSIT_ASSET_V2: '0xc3ae1766',
  DEPOSIT_ETH: '0x72c51c0b',
} as const;

export interface KelpDecodeResult {
  protocol: 'KelpDAO';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isKelpMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(KELP_SELECTORS).includes(selector as typeof KELP_SELECTORS[keyof typeof KELP_SELECTORS]);
}

export function decodeKelp(data: string, safeAddress: string): KelpDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case KELP_SELECTORS.DEPOSIT_ASSET_V1:
        return {
          protocol: 'KelpDAO',
          method: 'depositAsset',
          recipient: safeAddress,
          isImplicitSender: true,
        };

      case KELP_SELECTORS.DEPOSIT_ASSET_V2:
        return {
          protocol: 'KelpDAO',
          method: 'depositAsset',
          recipient: safeAddress,
          isImplicitSender: true,
        };

      case KELP_SELECTORS.DEPOSIT_ETH:
        return {
          protocol: 'KelpDAO',
          method: 'depositETH',
          recipient: safeAddress,
          isImplicitSender: true,
        };

      default:
        return null;
    }
  } catch {
    return null;
  }
}
