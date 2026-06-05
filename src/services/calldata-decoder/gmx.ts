import { Interface, AbiCoder } from 'ethers';

const GMX_V20_ABI = [
  `function createOrder(
    (
      (address receiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses,
      (uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount) numbers,
      uint8 orderType,
      uint8 decreasePositionSwapType,
      bool isLong,
      bool shouldUnwrapNativeToken,
      bytes32 referralCode
    ) params
  ) external payable returns (bytes32)`,
];

const GMX_V21_ABI = [
  `function createOrder(
    (
      (address receiver, address cancellationReceiver, address callbackContract, address uiFeeReceiver, address market, address initialCollateralToken, address[] swapPath) addresses,
      (uint256 sizeDeltaUsd, uint256 initialCollateralDeltaAmount, uint256 triggerPrice, uint256 acceptablePrice, uint256 executionFee, uint256 callbackGasLimit, uint256 minOutputAmount) numbers,
      uint8 orderType,
      uint8 decreasePositionSwapType,
      bool isLong,
      bool shouldUnwrapNativeToken,
      bytes32 referralCode
    ) params
  ) external payable returns (bytes32)`,
];

const GMX_MULTICALL_ABI = [
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory)',
];

const gmxV20Interface = new Interface(GMX_V20_ABI);
const gmxV21Interface = new Interface(GMX_V21_ABI);
const gmxMulticallInterface = new Interface(GMX_MULTICALL_ABI);

export const GMX_SELECTORS = {
  CREATE_ORDER_V2_0: '0x4a393a41',
  CREATE_ORDER_V2_1: '0x66e82ee2',
  MULTICALL: '0xac9650d8',
} as const;

export interface GmxDecodeResult {
  protocol: 'GMX';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isGmxMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(GMX_SELECTORS).includes(selector as typeof GMX_SELECTORS[keyof typeof GMX_SELECTORS]);
}

export function decodeGmx(data: string, safeAddress: string): GmxDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case GMX_SELECTORS.CREATE_ORDER_V2_0: {
        try {
          const decoded = gmxV20Interface.decodeFunctionData('createOrder', data);
          const params = decoded[0];
          const addresses = params[0];
          const receiver = addresses[0] as string;
          return {
            protocol: 'GMX',
            method: 'createOrder',
            recipient: receiver,
            isImplicitSender: false,
          };
        } catch {
          return { protocol: 'GMX', method: 'createOrder', recipient: null, isImplicitSender: true };
        }
      }

      case GMX_SELECTORS.CREATE_ORDER_V2_1: {
        try {
          const decoded = gmxV21Interface.decodeFunctionData('createOrder', data);
          const params = decoded[0];
          const addresses = params[0];
          const receiver = addresses[0] as string;
          return {
            protocol: 'GMX',
            method: 'createOrder',
            recipient: receiver,
            isImplicitSender: false,
          };
        } catch {
          return { protocol: 'GMX', method: 'createOrder', recipient: null, isImplicitSender: true };
        }
      }

      case GMX_SELECTORS.MULTICALL: {
        try {
          const decoded = gmxMulticallInterface.decodeFunctionData('multicall', data);
          const innerCalls = decoded[0] as string[];
          for (const callData of innerCalls) {
            const result = decodeGmx(callData, safeAddress);
            if (result && result.recipient) return result;
          }
        } catch { }
        return {
          protocol: 'GMX',
          method: 'multicall',
          recipient: null,
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
