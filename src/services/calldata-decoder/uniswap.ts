import { Interface, AbiCoder } from 'ethers';

const UNISWAP_V3_ROUTER_ABI = [
  `function exactInputSingle(
    (address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params
  ) external payable returns (uint256 amountOut)`,
  `function exactInput(
    (bytes path, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum) params
  ) external payable returns (uint256 amountOut)`,
  `function exactOutputSingle(
    (address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum, uint160 sqrtPriceLimitX96) params
  ) external payable returns (uint256 amountIn)`,
  `function exactOutput(
    (bytes path, address recipient, uint256 deadline, uint256 amountOut, uint256 amountInMaximum) params
  ) external payable returns (uint256 amountIn)`,
  'function multicall(uint256 deadline, bytes[] calldata data) external payable returns (bytes[] memory)',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory)',
];

const UNIVERSAL_ROUTER_ABI = [
  'function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable',
  'function execute(bytes calldata commands, bytes[] calldata inputs) external payable',
];

const uniswapV3Interface = new Interface(UNISWAP_V3_ROUTER_ABI);
const universalRouterInterface = new Interface(UNIVERSAL_ROUTER_ABI);

export const UNISWAP_SELECTORS = {
  EXACT_INPUT_SINGLE: '0x414bf389',
  EXACT_INPUT: '0xc04b8d59',
  EXACT_OUTPUT_SINGLE: '0xdb3e2198',
  EXACT_OUTPUT: '0xf28c0498',
  MULTICALL_DEADLINE: '0x5ae401dc',
  MULTICALL: '0xac9650d8',
  UNIVERSAL_EXECUTE_DEADLINE: '0x3593564c',
  UNIVERSAL_EXECUTE: '0x24856bc3',
} as const;

export interface UniswapDecodeResult {
  protocol: 'Uniswap V3' | 'Uniswap Universal Router';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isUniswapMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(UNISWAP_SELECTORS).includes(selector as typeof UNISWAP_SELECTORS[keyof typeof UNISWAP_SELECTORS]);
}

export function decodeUniswap(data: string, safeAddress: string): UniswapDecodeResult | null {
  if (!data || data.length < 10) return null;

  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case UNISWAP_SELECTORS.EXACT_INPUT_SINGLE: {
        const decoded = uniswapV3Interface.decodeFunctionData('exactInputSingle', data);
        const params = decoded[0] as {
          tokenIn: string;
          tokenOut: string;
          fee: bigint;
          recipient: string;
          deadline: bigint;
          amountIn: bigint;
          amountOutMinimum: bigint;
          sqrtPriceLimitX96: bigint;
        };
        return {
          protocol: 'Uniswap V3',
          method: 'exactInputSingle',
          recipient: params.recipient,
          isImplicitSender: false,
        };
      }

      case UNISWAP_SELECTORS.EXACT_INPUT: {
        const decoded = uniswapV3Interface.decodeFunctionData('exactInput', data);
        const params = decoded[0] as {
          path: string;
          recipient: string;
          deadline: bigint;
          amountIn: bigint;
          amountOutMinimum: bigint;
        };
        return {
          protocol: 'Uniswap V3',
          method: 'exactInput',
          recipient: params.recipient,
          isImplicitSender: false,
        };
      }

      case UNISWAP_SELECTORS.EXACT_OUTPUT_SINGLE: {
        const decoded = uniswapV3Interface.decodeFunctionData('exactOutputSingle', data);
        const params = decoded[0] as {
          tokenIn: string;
          tokenOut: string;
          fee: bigint;
          recipient: string;
          deadline: bigint;
          amountOut: bigint;
          amountInMaximum: bigint;
          sqrtPriceLimitX96: bigint;
        };
        return {
          protocol: 'Uniswap V3',
          method: 'exactOutputSingle',
          recipient: params.recipient,
          isImplicitSender: false,
        };
      }

      case UNISWAP_SELECTORS.EXACT_OUTPUT: {
        const decoded = uniswapV3Interface.decodeFunctionData('exactOutput', data);
        const params = decoded[0] as {
          path: string;
          recipient: string;
          deadline: bigint;
          amountOut: bigint;
          amountInMaximum: bigint;
        };
        return {
          protocol: 'Uniswap V3',
          method: 'exactOutput',
          recipient: params.recipient,
          isImplicitSender: false,
        };
      }

      case UNISWAP_SELECTORS.MULTICALL:
      case UNISWAP_SELECTORS.MULTICALL_DEADLINE: {
        const recipient = decodeMulticall(data, safeAddress);
        return {
          protocol: 'Uniswap V3',
          method: 'multicall',
          recipient,
          isImplicitSender: recipient === null,
        };
      }

      case UNISWAP_SELECTORS.UNIVERSAL_EXECUTE:
      case UNISWAP_SELECTORS.UNIVERSAL_EXECUTE_DEADLINE: {
        const recipient = decodeUniversalRouter(data, safeAddress);
        return {
          protocol: 'Uniswap Universal Router',
          method: 'execute',
          recipient: recipient || safeAddress,
          isImplicitSender: recipient === null,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

function decodeMulticall(data: string, safeAddress: string): string | null {
  try {
    const selector = data.slice(0, 10).toLowerCase();

    let innerCalls: string[];

    if (selector === UNISWAP_SELECTORS.MULTICALL_DEADLINE) {
      const decoded = uniswapV3Interface.decodeFunctionData('multicall(uint256,bytes[])', data);
      innerCalls = decoded[1] as string[];
    } else {
      const decoded = uniswapV3Interface.decodeFunctionData('multicall(bytes[])', data);
      innerCalls = decoded[0] as string[];
    }

    for (const callData of innerCalls) {
      const result = decodeUniswap(callData, safeAddress);
      if (result && result.recipient) {
        return result.recipient;
      }
    }

    return null;
  } catch {
    return null;
  }
}

function decodeUniversalRouter(data: string, safeAddress: string): string | null {
  try {
    const hex = data.startsWith('0x') ? data.slice(2) : data;

    const commandsOffset = parseInt(hex.slice(8, 8 + 64), 16) * 2;
    const inputsOffset = parseInt(hex.slice(8 + 64, 8 + 128), 16) * 2;

    const commandsLenPos = 8 + commandsOffset;
    const commandsLen = parseInt(hex.slice(commandsLenPos, commandsLenPos + 64), 16);
    const commandsHex = hex.slice(commandsLenPos + 64, commandsLenPos + 64 + commandsLen * 2);

    const inputsLenPos = 8 + inputsOffset;
    const inputsCount = parseInt(hex.slice(inputsLenPos, inputsLenPos + 64), 16);

    const inputOffsets: number[] = [];
    for (let i = 0; i < inputsCount; i++) {
      const offsetPos = inputsLenPos + 64 + i * 64;
      inputOffsets.push(parseInt(hex.slice(offsetPos, offsetPos + 64), 16) * 2);
    }

    for (let i = 0; i < commandsLen && i < inputsCount; i++) {
      const cmd = parseInt(commandsHex.slice(i * 2, i * 2 + 2), 16) & 0x3f;
      if (cmd !== 0x00 && cmd !== 0x01) continue;

      const inputStart = inputsLenPos + 64 + inputOffsets[i];
      const inputLen = parseInt(hex.slice(inputStart, inputStart + 64), 16);
      const inputHex = hex.slice(inputStart + 64, inputStart + 64 + inputLen * 2);

      if (inputHex.length >= 64) {
        const recipientWord = inputHex.slice(0, 64);
        const addr = '0x' + recipientWord.slice(24);

        if (addr === '0x0000000000000000000000000000000000000001') {
          return safeAddress;
        }
        if (addr === '0x0000000000000000000000000000000000000002') {
          continue;
        }
        if (addr !== '0x0000000000000000000000000000000000000000') {
          return addr;
        }
      }
    }

    return null;
  } catch {
    return null;
  }
}
