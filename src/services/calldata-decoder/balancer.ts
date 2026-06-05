import { Interface } from 'ethers';

const BALANCER_VAULT_ABI = [
  `function swap(
    (bytes32 poolId, uint8 kind, address assetIn, address assetOut, uint256 amount, bytes userData) singleSwap,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds,
    uint256 limit,
    uint256 deadline
  ) external payable returns (uint256 amountCalculated)`,
  `function batchSwap(
    uint8 kind,
    (bytes32 poolId, uint256 assetInIndex, uint256 assetOutIndex, uint256 amount, bytes userData)[] swaps,
    address[] assets,
    (address sender, bool fromInternalBalance, address recipient, bool toInternalBalance) funds,
    int256[] limits,
    uint256 deadline
  ) external payable returns (int256[] assetDeltas)`,
  `function joinPool(
    bytes32 poolId,
    address sender,
    address recipient,
    (address[] assets, uint256[] maxAmountsIn, bytes userData, bool fromInternalBalance) request
  ) external payable`,
  `function exitPool(
    bytes32 poolId,
    address sender,
    address payable recipient,
    (address[] assets, uint256[] minAmountsOut, bytes userData, bool toInternalBalance) request
  ) external`,
];

const balancerVaultInterface = new Interface(BALANCER_VAULT_ABI);

export const BALANCER_SELECTORS = {
  SWAP: '0x52bbbe29',
  BATCH_SWAP: '0x945bcec9',
  JOIN_POOL: '0xb95cac28',
  EXIT_POOL: '0x8bdb3913',
} as const;

export interface BalancerDecodeResult {
  protocol: 'Balancer';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isBalancerMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(BALANCER_SELECTORS).includes(selector as typeof BALANCER_SELECTORS[keyof typeof BALANCER_SELECTORS]);
}

export function decodeBalancer(data: string, safeAddress: string): BalancerDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case BALANCER_SELECTORS.SWAP: {
        const decoded = balancerVaultInterface.decodeFunctionData('swap', data);
        const funds = decoded[1];
        const recipient = funds[2] as string;
        return {
          protocol: 'Balancer',
          method: 'swap',
          recipient,
          isImplicitSender: false,
        };
      }

      case BALANCER_SELECTORS.BATCH_SWAP: {
        const decoded = balancerVaultInterface.decodeFunctionData('batchSwap', data);
        const funds = decoded[3];
        const recipient = funds[2] as string;
        return {
          protocol: 'Balancer',
          method: 'batchSwap',
          recipient,
          isImplicitSender: false,
        };
      }

      case BALANCER_SELECTORS.JOIN_POOL: {
        const decoded = balancerVaultInterface.decodeFunctionData('joinPool', data);
        const recipient = decoded[2] as string;
        return {
          protocol: 'Balancer',
          method: 'joinPool',
          recipient,
          isImplicitSender: false,
        };
      }

      case BALANCER_SELECTORS.EXIT_POOL: {
        const decoded = balancerVaultInterface.decodeFunctionData('exitPool', data);
        const recipient = decoded[2] as string;
        return {
          protocol: 'Balancer',
          method: 'exitPool',
          recipient,
          isImplicitSender: false,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
