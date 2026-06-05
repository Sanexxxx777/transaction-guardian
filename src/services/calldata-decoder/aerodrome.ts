import { Interface } from 'ethers';

const AERODROME_ROUTER_ABI = [
  `function swapExactTokensForTokens(
    uint256 amountIn,
    uint256 amountOutMin,
    (address from, address to, bool stable, address factory)[] routes,
    address to,
    uint256 deadline
  ) external returns (uint256[] amounts)`,
  `function swapExactETHForTokens(
    uint256 amountOutMin,
    (address from, address to, bool stable, address factory)[] routes,
    address to,
    uint256 deadline
  ) external payable returns (uint256[] amounts)`,
  `function swapExactTokensForETH(
    uint256 amountIn,
    uint256 amountOutMin,
    (address from, address to, bool stable, address factory)[] routes,
    address to,
    uint256 deadline
  ) external returns (uint256[] amounts)`,
  `function addLiquidity(
    address tokenA,
    address tokenB,
    bool stable,
    uint256 amountADesired,
    uint256 amountBDesired,
    uint256 amountAMin,
    uint256 amountBMin,
    address to,
    uint256 deadline
  ) external returns (uint256 amountA, uint256 amountB, uint256 liquidity)`,
  `function removeLiquidity(
    address tokenA,
    address tokenB,
    bool stable,
    uint256 liquidity,
    uint256 amountAMin,
    uint256 amountBMin,
    address to,
    uint256 deadline
  ) external returns (uint256 amountA, uint256 amountB)`,
  `function addLiquidityETH(
    address token,
    bool stable,
    uint256 amountTokenDesired,
    uint256 amountTokenMin,
    uint256 amountETHMin,
    address to,
    uint256 deadline
  ) external payable returns (uint256 amountToken, uint256 amountETH, uint256 liquidity)`,
];

const aerodromeInterface = new Interface(AERODROME_ROUTER_ABI);

export const AERODROME_SELECTORS = {
  SWAP_EXACT_TOKENS_FOR_TOKENS: '0xcac88ea9',
  SWAP_EXACT_ETH_FOR_TOKENS: '0x903638a4',
  SWAP_EXACT_TOKENS_FOR_ETH: '0xc6b7f1b6',
  ADD_LIQUIDITY: '0x5a47ddc3',
  REMOVE_LIQUIDITY: '0x0dede6c4',
  ADD_LIQUIDITY_ETH: '0xb7e0d4c0',
} as const;

export interface AerodromeDecodeResult {
  protocol: 'Aerodrome';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isAerodromeMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(AERODROME_SELECTORS).includes(selector as typeof AERODROME_SELECTORS[keyof typeof AERODROME_SELECTORS]);
}

export function decodeAerodrome(data: string, safeAddress: string): AerodromeDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case AERODROME_SELECTORS.SWAP_EXACT_TOKENS_FOR_TOKENS: {
        const decoded = aerodromeInterface.decodeFunctionData('swapExactTokensForTokens', data);
        const to = decoded[3] as string;
        return { protocol: 'Aerodrome', method: 'swapExactTokensForTokens', recipient: to, isImplicitSender: false };
      }
      case AERODROME_SELECTORS.SWAP_EXACT_ETH_FOR_TOKENS: {
        const decoded = aerodromeInterface.decodeFunctionData('swapExactETHForTokens', data);
        const to = decoded[2] as string;
        return { protocol: 'Aerodrome', method: 'swapExactETHForTokens', recipient: to, isImplicitSender: false };
      }
      case AERODROME_SELECTORS.SWAP_EXACT_TOKENS_FOR_ETH: {
        const decoded = aerodromeInterface.decodeFunctionData('swapExactTokensForETH', data);
        const to = decoded[3] as string;
        return { protocol: 'Aerodrome', method: 'swapExactTokensForETH', recipient: to, isImplicitSender: false };
      }
      case AERODROME_SELECTORS.ADD_LIQUIDITY: {
        const decoded = aerodromeInterface.decodeFunctionData('addLiquidity', data);
        const to = decoded[7] as string;
        return { protocol: 'Aerodrome', method: 'addLiquidity', recipient: to, isImplicitSender: false };
      }
      case AERODROME_SELECTORS.REMOVE_LIQUIDITY: {
        const decoded = aerodromeInterface.decodeFunctionData('removeLiquidity', data);
        const to = decoded[6] as string;
        return { protocol: 'Aerodrome', method: 'removeLiquidity', recipient: to, isImplicitSender: false };
      }
      case AERODROME_SELECTORS.ADD_LIQUIDITY_ETH: {
        const decoded = aerodromeInterface.decodeFunctionData('addLiquidityETH', data);
        const to = decoded[5] as string;
        return { protocol: 'Aerodrome', method: 'addLiquidityETH', recipient: to, isImplicitSender: false };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
