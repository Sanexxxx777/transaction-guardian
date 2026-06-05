import { Interface, AbiCoder } from 'ethers';

const ERC20_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
];

const erc20Interface = new Interface(ERC20_ABI);

export const ERC20_SELECTORS = {
  TRANSFER: '0xa9059cbb',
  APPROVE: '0x095ea7b3',
  TRANSFER_FROM: '0x23b872dd',
} as const;

export const MAX_UINT256 = '0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
export const MAX_UINT256_BIGINT = BigInt(MAX_UINT256);

export interface ERC20TransferResult {
  method: 'transfer';
  to: string;
  amount: bigint;
}

export interface ERC20ApproveResult {
  method: 'approve';
  spender: string;
  amount: bigint;
  isUnlimited: boolean;
}

export interface ERC20TransferFromResult {
  method: 'transferFrom';
  from: string;
  to: string;
  amount: bigint;
}

export type ERC20DecodeResult = ERC20TransferResult | ERC20ApproveResult | ERC20TransferFromResult;

export function isERC20Method(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(ERC20_SELECTORS).includes(selector as typeof ERC20_SELECTORS[keyof typeof ERC20_SELECTORS]);
}

export function decodeERC20(data: string): ERC20DecodeResult | null {
  if (!data || data.length < 10) return null;

  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case ERC20_SELECTORS.TRANSFER: {
        const decoded = erc20Interface.decodeFunctionData('transfer', data);
        return {
          method: 'transfer',
          to: decoded[0] as string,
          amount: decoded[1] as bigint,
        };
      }

      case ERC20_SELECTORS.APPROVE: {
        const decoded = erc20Interface.decodeFunctionData('approve', data);
        const amount = decoded[1] as bigint;
        return {
          method: 'approve',
          spender: decoded[0] as string,
          amount,
          isUnlimited: amount >= MAX_UINT256_BIGINT,
        };
      }

      case ERC20_SELECTORS.TRANSFER_FROM: {
        const decoded = erc20Interface.decodeFunctionData('transferFrom', data);
        return {
          method: 'transferFrom',
          from: decoded[0] as string,
          to: decoded[1] as string,
          amount: decoded[2] as bigint,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function getERC20Recipient(decoded: ERC20DecodeResult): string | null {
  switch (decoded.method) {
    case 'transfer':
      return decoded.to;
    case 'transferFrom':
      return decoded.to;
    case 'approve':
      return null;
    default:
      return null;
  }
}
