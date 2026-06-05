import { Interface } from 'ethers';

const CURVE_POOL_ABI = [
  'function exchange(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256)',
  'function exchange_underlying(int128 i, int128 j, uint256 dx, uint256 min_dy) external returns (uint256)',
  'function add_liquidity(uint256[2] amounts, uint256 min_mint_amount) external returns (uint256)',
  'function remove_liquidity(uint256 _amount, uint256[2] min_amounts) external returns (uint256[2])',
  'function remove_liquidity_one_coin(uint256 _token_amount, int128 i, uint256 min_amount) external returns (uint256)',
];

const curvePoolInterface = new Interface(CURVE_POOL_ABI);

export const CURVE_SELECTORS = {
  EXCHANGE: '0x3df02124',
  EXCHANGE_UNDERLYING: '0xa6417ed6',
  ADD_LIQUIDITY_2: '0x0b4c7e4d',
  REMOVE_LIQUIDITY_2: '0x5b36389c',
  REMOVE_LIQUIDITY_ONE: '0x1a4d01d2',
} as const;

export interface CurveDecodeResult {
  protocol: 'Curve';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isCurveMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(CURVE_SELECTORS).includes(selector as typeof CURVE_SELECTORS[keyof typeof CURVE_SELECTORS]);
}

export function decodeCurve(data: string, safeAddress: string): CurveDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case CURVE_SELECTORS.EXCHANGE: {
        return {
          protocol: 'Curve',
          method: 'exchange',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case CURVE_SELECTORS.EXCHANGE_UNDERLYING: {
        return {
          protocol: 'Curve',
          method: 'exchange_underlying',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case CURVE_SELECTORS.ADD_LIQUIDITY_2: {
        return {
          protocol: 'Curve',
          method: 'add_liquidity',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case CURVE_SELECTORS.REMOVE_LIQUIDITY_2: {
        return {
          protocol: 'Curve',
          method: 'remove_liquidity',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case CURVE_SELECTORS.REMOVE_LIQUIDITY_ONE: {
        return {
          protocol: 'Curve',
          method: 'remove_liquidity_one_coin',
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
