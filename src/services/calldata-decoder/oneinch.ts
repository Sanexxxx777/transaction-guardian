import { Interface } from 'ethers';

const ONEINCH_V5_ABI = [
  `function swap(
    address executor,
    (address srcToken, address dstToken, address srcReceiver, address dstReceiver, uint256 amount, uint256 minReturnAmount, uint256 flags) desc,
    bytes permit,
    bytes data
  ) external payable returns (uint256 returnAmount, uint256 spentAmount)`,
  'function unoswap(address srcToken, uint256 amount, uint256 minReturn, uint256[] calldata pools) external payable returns (uint256 returnAmount)',
  'function unoswapTo(address recipient, address srcToken, uint256 amount, uint256 minReturn, uint256[] calldata pools) external payable returns (uint256 returnAmount)',
  'function uniswapV3Swap(uint256 amount, uint256 minReturn, uint256[] calldata pools) external payable returns (uint256 returnAmount)',
  'function uniswapV3SwapTo(address recipient, uint256 amount, uint256 minReturn, uint256[] calldata pools) external payable returns (uint256 returnAmount)',
];

const oneInchInterface = new Interface(ONEINCH_V5_ABI);

export const ONEINCH_SELECTORS = {
  SWAP: '0x12aa3caf',
  UNOSWAP: '0x0502b1c5',
  UNOSWAP_TO: '0xf78dc253',
  UNISWAP_V3_SWAP: '0xe449022e',
  UNISWAP_V3_SWAP_TO: '0xbc80f1a8',
} as const;

export interface OneInchDecodeResult {
  protocol: '1inch';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isOneInchMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(ONEINCH_SELECTORS).includes(selector as typeof ONEINCH_SELECTORS[keyof typeof ONEINCH_SELECTORS]);
}

export function decodeOneInch(data: string, safeAddress: string): OneInchDecodeResult | null {
  if (!data || data.length < 10) return null;

  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case ONEINCH_SELECTORS.SWAP: {
        const decoded = oneInchInterface.decodeFunctionData('swap', data);
        const desc = decoded[1] as {
          srcToken: string;
          dstToken: string;
          srcReceiver: string;
          dstReceiver: string;
          amount: bigint;
          minReturnAmount: bigint;
          flags: bigint;
        };
        return {
          protocol: '1inch',
          method: 'swap',
          recipient: desc.dstReceiver,
          isImplicitSender: false,
        };
      }

      case ONEINCH_SELECTORS.UNOSWAP: {
        return {
          protocol: '1inch',
          method: 'unoswap',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case ONEINCH_SELECTORS.UNOSWAP_TO: {
        const decoded = oneInchInterface.decodeFunctionData('unoswapTo', data);
        return {
          protocol: '1inch',
          method: 'unoswapTo',
          recipient: decoded[0] as string,
          isImplicitSender: false,
        };
      }

      case ONEINCH_SELECTORS.UNISWAP_V3_SWAP: {
        return {
          protocol: '1inch',
          method: 'uniswapV3Swap',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case ONEINCH_SELECTORS.UNISWAP_V3_SWAP_TO: {
        const decoded = oneInchInterface.decodeFunctionData('uniswapV3SwapTo', data);
        return {
          protocol: '1inch',
          method: 'uniswapV3SwapTo',
          recipient: decoded[0] as string,
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
