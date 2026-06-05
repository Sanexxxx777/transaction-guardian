import { createLogger } from '../../utils/logger.js';
import { isERC20Method, decodeERC20, getERC20Recipient } from './erc20.js';
import { isUniswapMethod, decodeUniswap } from './uniswap.js';
import { isOneInchMethod, decodeOneInch } from './oneinch.js';
import { isAaveMethod, decodeAave } from './aave.js';
import { isLidoMethod, decodeLido } from './lido.js';
import { isCurveMethod, decodeCurve } from './curve.js';
import { isCompoundMethod, decodeCompound } from './compound.js';
import { isWethContract, isWethMethod, decodeWeth } from './weth.js';
import { isCowContract, isCowMethod, decodeCow } from './cow.js';
import { isAcrossMethod, decodeAcross } from './across.js';
import { isFluidMethod, decodeFluid } from './fluid.js';
import { isKelpMethod, decodeKelp } from './kelpdao.js';
import { isAerodromeMethod, decodeAerodrome } from './aerodrome.js';
import { isAuraMethod, decodeAura } from './aura.js';
import { isBalancerMethod, decodeBalancer } from './balancer.js';
import { isGainsMethod, decodeGains } from './gains.js';
import { isGmxMethod, decodeGmx } from './gmx.js';
import { decodeSelector, getDisplayMethodName } from './signature-lookup.js';
import { isBridgeAggregator, decodeBridge } from './bridge.js';
import { isSafeAdminMethod, decodeSafeAdmin } from './safe.js';
import type { RecipientExtractionResult } from '../../models/transaction.js';

interface GenericDecodeResult {
  protocol: string;
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}
const GENERIC_DECODERS: Array<{
  is: (data: string) => boolean;
  decode: (data: string, safeAddress: string) => GenericDecodeResult | null;
}> = [
  { is: isFluidMethod, decode: decodeFluid },
  { is: isKelpMethod, decode: decodeKelp },
  { is: isAerodromeMethod, decode: decodeAerodrome },
  { is: isAuraMethod, decode: decodeAura },
  { is: isBalancerMethod, decode: decodeBalancer },
  { is: isGainsMethod, decode: decodeGains },
  { is: isGmxMethod, decode: decodeGmx },
];

const logger = createLogger('calldata-decoder');

const MULTISEND_SELECTOR = '0x8d80ff0a';

const UNISWAP_FORK_ROUTERS: Record<string, string> = {
  '0xfe6508f0015c778bdcc1fb5465ba5ebe224c9912': 'PancakeSwap',
  '0x32226588378236fd0c7c4053999f88ac0e5cac77': 'PancakeSwap',
  '0x1b81d678ffb9c0263b24a97847620c99d213eb14': 'PancakeSwap',
  '0x13f4ea83d0bd40e75c8222255bc855a974568dd4': 'PancakeSwap',

  '0x6df1c91424f79e40e33b1a48f0687b666be71075': 'Aerodrome',
  '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43': 'Aerodrome',
  '0x827922686190790b37229fd06084350e74485b72': 'Aerodrome',

  '0xa062ae8a9c5e11aaa026fc2670b0d65ccc8b2858': 'Velodrome',
  '0x9c12939390052919af3155f41bf4160fd3666a6f': 'Velodrome',

  '0x1b02da8cb0d097eb8d57a175b88c7d8b47997506': 'SushiSwap',
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': 'SushiSwap',
};

function resolveSwapProtocol(to?: string): string {
  if (to) {
    const fork = UNISWAP_FORK_ROUTERS[to.toLowerCase()];
    if (fork) return fork;
  }
  return 'Uniswap';
}

interface InnerCall {
  to: string;
  data: string;
  value: bigint;
}

function parseMultiSendCalls(hexData: string): InnerCall[] {
  try {
    const hex = hexData.startsWith('0x') ? hexData.slice(2) : hexData;

    let pos = 136;
    const calls: InnerCall[] = [];

    while (pos + 2 + 40 + 64 + 64 <= hex.length) {
      pos += 2;
      const to = '0x' + hex.slice(pos, pos + 40);
      pos += 40;
      const value = BigInt('0x' + (hex.slice(pos, pos + 64) || '0'));
      pos += 64;
      const dataLen = Number(BigInt('0x' + (hex.slice(pos, pos + 64) || '0')));
      pos += 64;
      if (dataLen > 100_000 || pos + dataLen * 2 > hex.length) break;
      const data = dataLen > 0 ? '0x' + hex.slice(pos, pos + dataLen * 2) : '0x';
      pos += dataLen * 2;
      calls.push({ to, data, value });
    }

    return calls;
  } catch {
    return [];
  }
}

function describeInnerCall(call: InnerCall): string {
  if (!call.data || call.data === '0x') return 'ETH transfer';

  if (isSafeAdminMethod(call.data)) {
    const d = decodeSafeAdmin(call.data);
    if (d) return d.method;
    return SAFE_METHODS[call.data.slice(0, 10).toLowerCase()] ?? call.data.slice(0, 10);
  }
  if (isERC20Method(call.data)) {
    const decoded = decodeERC20(call.data);
    if (decoded) return decoded.method;
  }
  if (isUniswapMethod(call.data)) return 'Uniswap swap';
  if (isOneInchMethod(call.data)) return '1inch swap';
  if (isAaveMethod(call.data)) {
    const d = decodeAave(call.data, '');
    return d?.method ? `AAVE ${d.method}` : 'AAVE';
  }
  if (isLidoMethod(call.data)) {
    const d = decodeLido(call.data, '');
    return d?.method ? `Lido ${d.method}` : 'Lido';
  }
  if (isCurveMethod(call.data)) return 'Curve swap';
  if (isCompoundMethod(call.data)) return 'Compound';
  if (isCowMethod(call.data)) {
    const d = decodeCow(call.data, '');
    return d?.method ? `CoW: ${d.method}` : 'CoW Protocol';
  }
  if (isAcrossMethod(call.data)) {
    const d = decodeAcross(call.data, '');
    return d?.method ? `Across ${d.method}` : 'Across bridge';
  }
  return call.data.slice(0, 10);
}

function buildMultiSendDescription(calls: InnerCall[]): string {
  if (calls.length === 0) return 'multiSend';
  if (calls.length === 1) return describeInnerCall(calls[0]);
  const parts = calls.slice(0, 3).map(c => describeInnerCall(c));
  const suffix = calls.length > 3 ? ` +${calls.length - 3}` : '';
  return `Batch (${calls.length}): ${parts.join(', ')}${suffix}`;
}

function detectMultiSendProtocol(calls: InnerCall[]): { protocol: string; primaryMethod?: string } {
  for (const call of calls) {
    if (!call.data || call.data === '0x') continue;
    if (isCowMethod(call.data)) {
      const d = decodeCow(call.data, '');
      return { protocol: 'CoW Protocol', primaryMethod: d?.method };
    }
    if (isUniswapMethod(call.data)) {
      const d = decodeUniswap(call.data, '');
      return { protocol: d?.protocol || 'Uniswap', primaryMethod: d?.method };
    }
    if (isOneInchMethod(call.data)) {
      const d = decodeOneInch(call.data, '');
      return { protocol: '1inch', primaryMethod: d?.method };
    }
    if (isAaveMethod(call.data)) {
      const d = decodeAave(call.data, '');
      return { protocol: 'AAVE', primaryMethod: d?.method };
    }
    if (isLidoMethod(call.data)) {
      const d = decodeLido(call.data, '');
      return { protocol: 'Lido', primaryMethod: d?.method };
    }
    if (isAcrossMethod(call.data)) {
      const d = decodeAcross(call.data, '');
      return { protocol: 'Across', primaryMethod: d?.method };
    }
  }
  return { protocol: 'Safe: MultiSend' };
}

export interface MultiSendInnerCallSummary {
  to: string;
  method: string | null;
  protocol: string | null;

  params?: Record<string, unknown> | null;
}

export function summarizeMultiSendCalls(data: string | null): MultiSendInnerCallSummary[] {
  if (!data || data.length < 10) return [];
  if (data.slice(0, 10).toLowerCase() !== MULTISEND_SELECTOR) return [];
  const calls = parseMultiSendCalls(data);
  return calls.map(c => {
    let method: string | null = null;
    let protocol: string | null = null;
    let params: Record<string, unknown> | null = null;
    if (!c.data || c.data === '0x') {
      method = 'ETH transfer';
    } else if (isSafeAdminMethod(c.data)) {
      const d = decodeSafeAdmin(c.data);
      method = d?.method || (SAFE_METHODS[c.data.slice(0, 10).toLowerCase()] ?? c.data.slice(0, 10));
      protocol = 'Safe';
      params = d as unknown as Record<string, unknown> | null;
    } else if (isERC20Method(c.data)) {
      const d = decodeERC20(c.data);
      method = d?.method || c.data.slice(0, 10);
    } else if (isCowMethod(c.data)) {
      const d = decodeCow(c.data, '');
      method = d?.method || 'CoW';
      protocol = 'CoW Protocol';
    } else if (isUniswapMethod(c.data)) {
      const d = decodeUniswap(c.data, '');
      method = d?.method || 'swap';
      protocol = d?.protocol || 'Uniswap';
    } else if (isOneInchMethod(c.data)) {
      const d = decodeOneInch(c.data, '');
      method = d?.method || 'swap';
      protocol = '1inch';
    } else if (isAaveMethod(c.data)) {
      const d = decodeAave(c.data, '');
      method = d?.method || 'aave';
      protocol = 'AAVE';
    } else if (isLidoMethod(c.data)) {
      const d = decodeLido(c.data, '');
      method = d?.method || 'lido';
      protocol = 'Lido';
    } else if (isCurveMethod(c.data)) {
      method = 'curve';
      protocol = 'Curve';
    } else if (isCompoundMethod(c.data)) {
      method = 'compound';
      protocol = 'Compound';
    } else if (isAcrossMethod(c.data)) {
      const d = decodeAcross(c.data, '');
      method = d?.method || 'across';
      protocol = 'Across';
    } else {
      method = c.data.slice(0, 10);
    }
    return { to: c.to, method, protocol, params };
  });
}

function extractMultiSendApprove(calls: InnerCall[]): Record<string, unknown> | null {
  for (const call of calls) {
    if (!call.data || !isERC20Method(call.data)) continue;
    const decoded = decodeERC20(call.data);
    if (decoded?.method === 'approve') {
      return { ...decoded, tokenAddress: call.to };
    }
  }
  return null;
}

const SAFE_METHODS: Record<string, string> = {
  '0x0d582f13': 'addOwnerWithThreshold',
  '0xf8dc5dd9': 'removeOwner',
  '0xe318b52b': 'swapOwner',
  '0x694e80c3': 'changeThreshold',
  '0x6a761202': 'execTransaction',
  '0x610b5925': 'enableModule',
  '0xe009cfde': 'disableModule',
  '0xe19a9dd9': 'setGuard',
  '0xd4d9bdcd': 'approveHash',
  '0xf698da25': 'domainSeparator',
  '0x934f3a11': 'setup',
};

const SAFE_METHOD_LABELS: Record<string, string> = {
  addOwnerWithThreshold: 'Добавление владельца',
  removeOwner: 'Удаление владельца',
  changeThreshold: 'Изменение порога подписей',
  execTransaction: 'Вложенная транзакция',
  swapOwner: 'Замена владельца',
  enableModule: 'Включение модуля',
  disableModule: 'Отключение модуля',
  setGuard: 'Установка guard',
  approveHash: 'Подтверждение хэша',
  setup: 'Инициализация Safe',
};

function isSafeMethod(data: string): boolean {
  return data.length >= 10 && data.slice(0, 10).toLowerCase() in SAFE_METHODS;
}

export { decodeERC20, isERC20Method, MAX_UINT256, MAX_UINT256_BIGINT } from './erc20.js';
export { decodeUniswap, isUniswapMethod } from './uniswap.js';
export { decodeOneInch, isOneInchMethod } from './oneinch.js';
export { decodeAave, isAaveMethod } from './aave.js';
export { decodeLido, isLidoMethod } from './lido.js';
export { decodeCurve, isCurveMethod } from './curve.js';
export { decodeCompound, isCompoundMethod } from './compound.js';
export { isWethContract, isWethMethod, decodeWeth } from './weth.js';
export { isCowContract, isCowMethod, decodeCow, isCowExpectedRevert } from './cow.js';
export { isAcrossMethod, decodeAcross } from './across.js';
export { isFluidMethod, decodeFluid } from './fluid.js';
export { isKelpMethod, decodeKelp } from './kelpdao.js';
export { isAerodromeMethod, decodeAerodrome } from './aerodrome.js';
export { isAuraMethod, decodeAura } from './aura.js';
export { isBalancerMethod, decodeBalancer } from './balancer.js';
export { isGainsMethod, decodeGains } from './gains.js';
export { isGmxMethod, decodeGmx } from './gmx.js';
export { decodeSelector, getDisplayMethodName, getProtocolDisplayMethod } from './signature-lookup.js';
export { isBridgeAggregator, decodeBridge } from './bridge.js';
export { isSafeAdminMethod, decodeSafeAdmin } from './safe.js';
export type { SafeAdminDecodeResult, SafeAdminMethod } from './safe.js';

export function extractRecipient(
  to: string,
  data: string | null,
  safeAddress: string,
): RecipientExtractionResult {
  if (to.toLowerCase() === safeAddress.toLowerCase()) {
    if (!data || data === '0x' || data === '0x00') {
      return {
        recipient: null,
        protocol: 'Safe',
        method: 'Отмена транзакции',
        confidence: 'high',
        isImplicitSender: false,
      };
    }
    const selector = data.length >= 10 ? data.slice(0, 10).toLowerCase() : '';
    const method = SAFE_METHODS[selector] || 'safeManagement';
    const label = SAFE_METHOD_LABELS[method] || 'Управление Safe';
    return {
      recipient: null,
      protocol: 'Safe',
      method: label,
      confidence: 'high',
      isImplicitSender: false,
    };
  }

  if (!data || data === '0x') {
    return {
      recipient: to,
      protocol: null,
      method: 'native_transfer',
      confidence: 'high',
      isImplicitSender: false,
    };
  }

  if (isWethContract(to) && isWethMethod(data)) {
    const decoded = decodeWeth(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: 'high',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isERC20Method(data)) {
    const decoded = decodeERC20(data);
    if (decoded) {
      const recipient = getERC20Recipient(decoded);
      return {
        recipient,
        protocol: 'ERC20',
        method: decoded.method,
        confidence: 'high',
        isImplicitSender: false,
      };
    }
  }

  if (isUniswapMethod(data)) {
    const decoded = decodeUniswap(data, safeAddress);
    if (decoded) {
      const forkProtocol = resolveSwapProtocol(to);
      return {
        recipient: decoded.recipient,
        protocol: forkProtocol === 'Uniswap' ? decoded.protocol : forkProtocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isOneInchMethod(data)) {
    const decoded = decodeOneInch(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isAaveMethod(data)) {
    const decoded = decodeAave(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isLidoMethod(data)) {
    const decoded = decodeLido(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isCurveMethod(data)) {
    const decoded = decodeCurve(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isCompoundMethod(data)) {
    const decoded = decodeCompound(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isAcrossMethod(data)) {
    const decoded = decodeAcross(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (isCowContract(to) && isCowMethod(data)) {
    const decoded = decodeCow(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.confidence || 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  for (const { is, decode } of GENERIC_DECODERS) {
    if (!is(data)) continue;
    const decoded = decode(data, safeAddress);
    if (decoded) {
      return {
        recipient: decoded.recipient,
        protocol: decoded.protocol,
        method: decoded.method,
        confidence: decoded.recipient ? 'high' : 'medium',
        isImplicitSender: decoded.isImplicitSender,
      };
    }
  }

  if (data.length >= 10 && data.slice(0, 10).toLowerCase() === MULTISEND_SELECTOR) {
    const calls = parseMultiSendCalls(data);
    return {
      recipient: null,
      protocol: 'Safe: MultiSend',
      method: buildMultiSendDescription(calls),
      confidence: 'high',
      isImplicitSender: true,
    };
  }

  if (isBridgeAggregator(to)) {
    const bridgeResult = decodeBridge(to, data);
    if (bridgeResult) {
      return {
        recipient: bridgeResult.receiver,
        protocol: bridgeResult.protocol,
        method: bridgeResult.method,
        confidence: bridgeResult.receiver ? 'high' : 'medium',
        isImplicitSender: false,
      };
    }
  }

  logger.debug({ to, selector: data.slice(0, 10) }, 'Unknown method, cannot extract recipient');

  return {
    recipient: null,
    protocol: null,
    method: 'unknown',
    confidence: 'low',
    isImplicitSender: false,
  };
}

export function decodeCalldata(data: string | null, to?: string): {
  method: string | null;
  params: Record<string, unknown> | null;
  protocol: string | null;
  destinationChainId?: number | null;
} {
  if (!data || data === '0x') {
    return { method: null, params: null, protocol: null };
  }

  if (isSafeMethod(data)) {
    const methodKey = SAFE_METHODS[data.slice(0, 10).toLowerCase()];
    const label = SAFE_METHOD_LABELS[methodKey] || methodKey;
    const decoded = isSafeAdminMethod(data) ? decodeSafeAdmin(data) : null;
    return {
      method: label,
      params: decoded as unknown as Record<string, unknown> | null,
      protocol: 'Safe',
    };
  }

  if (isWethMethod(data)) {
    const decoded = decodeWeth(data, '');
    if (decoded) {
      return {
        method: decoded.method,
        params: null,
        protocol: 'WETH',
      };
    }
  }

  if (isERC20Method(data)) {
    const decoded = decodeERC20(data);
    if (decoded) {
      return {
        method: decoded.method,
        params: decoded as unknown as Record<string, unknown>,
        protocol: 'ERC20',
      };
    }
  }

  if (isUniswapMethod(data)) {
    const uniResult = decodeUniswap(data, '');
    const forkName = resolveSwapProtocol(to);
    return {
      method: uniResult?.method || data.slice(0, 10),
      params: null,
      protocol: forkName !== 'Uniswap' ? forkName : (uniResult?.protocol || 'Uniswap'),
    };
  }

  if (isOneInchMethod(data)) {
    const inchResult = decodeOneInch(data, '');
    return {
      method: inchResult?.method || data.slice(0, 10),
      params: null,
      protocol: '1inch',
    };
  }

  if (isAaveMethod(data)) {
    const decoded = decodeAave(data, '');
    return {
      method: decoded?.method || data.slice(0, 10),
      params: null,
      protocol: 'AAVE',
    };
  }

  if (isLidoMethod(data)) {
    const decoded = decodeLido(data, '');
    return {
      method: decoded?.method || data.slice(0, 10),
      params: null,
      protocol: 'Lido',
    };
  }

  if (isCurveMethod(data)) {
    const decoded = decodeCurve(data, '');
    return {
      method: decoded?.method || data.slice(0, 10),
      params: null,
      protocol: 'Curve',
    };
  }

  if (isCompoundMethod(data)) {
    const decoded = decodeCompound(data, '');
    return {
      method: decoded?.method || data.slice(0, 10),
      params: null,
      protocol: 'Compound',
    };
  }

  if (isAcrossMethod(data)) {
    const decoded = decodeAcross(data, '');
    if (decoded) {
      return {
        method: decoded.method,
        params: null,
        protocol: 'Across',
        destinationChainId: decoded.destinationChainId,
      };
    }
  }

  if (isCowMethod(data)) {
    const decoded = decodeCow(data, '');
    if (decoded) {
      return {
        method: decoded.method,
        params: null,
        protocol: 'CoW Protocol',
      };
    }
  }

  for (const { is, decode } of GENERIC_DECODERS) {
    if (!is(data)) continue;
    const decoded = decode(data, '');
    if (decoded) {
      return {
        method: decoded.method,
        params: null,
        protocol: decoded.protocol,
      };
    }
  }

  if (data.slice(0, 10).toLowerCase() === MULTISEND_SELECTOR) {
    const calls = parseMultiSendCalls(data);
    const { protocol, primaryMethod } = detectMultiSendProtocol(calls);
    const approveParams = extractMultiSendApprove(calls);
    return {
      method: primaryMethod || buildMultiSendDescription(calls),
      params: approveParams,
      protocol,
    };
  }

  return {
    method: data.slice(0, 10),
    params: null,
    protocol: null,
  };
}
