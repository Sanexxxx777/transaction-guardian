import { Interface } from 'ethers';

const AAVE_GATEWAY_ABI = [
  'function withdrawETH(address pool, uint256 amount, address to) external',
  'function depositETH(address pool, address onBehalfOf, uint16 referralCode) external payable',
  'function borrowETH(address pool, uint256 amount, uint16 referralCode) external',
  'function repayETH(address pool, uint256 amount, address onBehalfOf) external payable',
];

const AAVE_POOL_ABI = [
  'function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external',
  'function withdraw(address asset, uint256 amount, address to) external returns (uint256)',
  'function borrow(address asset, uint256 amount, uint256 interestRateMode, uint16 referralCode, address onBehalfOf) external',
  'function repay(address asset, uint256 amount, uint256 interestRateMode, address onBehalfOf) external returns (uint256)',
];

const aaveGatewayInterface = new Interface(AAVE_GATEWAY_ABI);
const aavePoolInterface = new Interface(AAVE_POOL_ABI);

export const AAVE_SELECTORS = {
  WITHDRAW_ETH: '0x80500d20',
  DEPOSIT_ETH: '0x474cf53d',
  BORROW_ETH: '0x66514c97',
  REPAY_ETH: '0x02c5fcf8',

  SUPPLY: '0x617ba037',
  WITHDRAW: '0x69328dec',
  BORROW: '0xa415bcad',
  REPAY: '0x573ade81',
} as const;

export interface AaveDecodeResult {
  protocol: 'AAVE';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isAaveMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(AAVE_SELECTORS).includes(selector as typeof AAVE_SELECTORS[keyof typeof AAVE_SELECTORS]);
}

export function decodeAave(data: string, safeAddress: string): AaveDecodeResult | null {
  if (!data || data.length < 10) return null;

  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case AAVE_SELECTORS.WITHDRAW_ETH: {
        const decoded = aaveGatewayInterface.decodeFunctionData('withdrawETH', data);
        const to = decoded[2] as string;
        return {
          protocol: 'AAVE',
          method: 'withdrawETH',
          recipient: to,
          isImplicitSender: false,
        };
      }

      case AAVE_SELECTORS.DEPOSIT_ETH: {
        const decoded = aaveGatewayInterface.decodeFunctionData('depositETH', data);
        const onBehalfOf = decoded[1] as string;
        return {
          protocol: 'AAVE',
          method: 'depositETH',
          recipient: onBehalfOf,
          isImplicitSender: false,
        };
      }

      case AAVE_SELECTORS.BORROW_ETH: {
        return {
          protocol: 'AAVE',
          method: 'borrowETH',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case AAVE_SELECTORS.REPAY_ETH: {
        const decoded = aaveGatewayInterface.decodeFunctionData('repayETH', data);
        const onBehalfOf = decoded[2] as string;
        return {
          protocol: 'AAVE',
          method: 'repayETH',
          recipient: onBehalfOf,
          isImplicitSender: false,
        };
      }

      case AAVE_SELECTORS.SUPPLY: {
        const decoded = aavePoolInterface.decodeFunctionData('supply', data);
        const onBehalfOf = decoded[2] as string;
        return {
          protocol: 'AAVE',
          method: 'supply',
          recipient: onBehalfOf,
          isImplicitSender: false,
        };
      }

      case AAVE_SELECTORS.WITHDRAW: {
        const decoded = aavePoolInterface.decodeFunctionData('withdraw', data);
        const to = decoded[2] as string;
        return {
          protocol: 'AAVE',
          method: 'withdraw',
          recipient: to,
          isImplicitSender: false,
        };
      }

      case AAVE_SELECTORS.BORROW: {
        return {
          protocol: 'AAVE',
          method: 'borrow',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case AAVE_SELECTORS.REPAY: {
        const decoded = aavePoolInterface.decodeFunctionData('repay', data);
        const onBehalfOf = decoded[3] as string;
        return {
          protocol: 'AAVE',
          method: 'repay',
          recipient: onBehalfOf,
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
