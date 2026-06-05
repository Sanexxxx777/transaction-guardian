import axios from 'axios';
import { redis, isRedisAvailable } from '../../db/redis.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('signature-lookup');

const REDIS_SIG_PREFIX = 'sig:';
const REDIS_SIG_TTL = 7 * 24 * 60 * 60;

const signatureCache = new Map<string, string | null>();

const KNOWN_SIGNATURES: Record<string, string> = {
  '0xa9059cbb': 'transfer(address,uint256)',
  '0x23b872dd': 'transferFrom(address,address,uint256)',
  '0x095ea7b3': 'approve(address,uint256)',

  '0x80500d20': 'withdrawETH(address,uint256,address)',
  '0x474cf53d': 'depositETH(address,address,uint16)',
  '0x66514c97': 'borrowETH(address,uint256,uint16)',
  '0x02c5fcf8': 'repayETH(address,uint256,address)',

  '0x617ba037': 'supply(address,uint256,address,uint16)',
  '0x69328dec': 'withdraw(address,uint256,address)',
  '0xa415bcad': 'borrow(address,uint256,uint256,uint16,address)',
  '0x573ade81': 'repay(address,uint256,uint256,address)',

  '0x414bf389': 'exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))',
  '0xc04b8d59': 'exactInput((bytes,address,uint256,uint256,uint256))',
  '0x5ae401dc': 'multicall(uint256,bytes[])',
  '0xac9650d8': 'multicall(bytes[])',
  '0x3593564c': 'execute(bytes,bytes[],uint256)',

  '0xd0e30db0': 'deposit()',
  '0x2e1a7d4d': 'withdraw(uint256)',

  '0xec6cb13f': 'setPreSignature(bytes,bool)',
  '0x2689f0a7': 'invalidateOrder(bytes)',
  '0x13d79a0b': 'settle(bytes[],bytes[],bytes[][3][])',

  '0x7b939232': 'depositV3(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)',
  '0xd2645d20': 'deposit(address,address,address,address,uint256,uint256,uint256,address,uint32,uint32,uint32,bytes)',
  '0x656a20e6': 'depositNative(address,bytes32,address,uint256,bytes32,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)',
  '0x13eb1e6f': 'swapAndBridge((address,address,address,uint256,bytes32,uint256,bytes32,uint256,uint256,bytes32,uint32,uint32,uint32,bytes,address,bytes,uint256))',

  '0x': 'Native Transfer',
};

const METHOD_DISPLAY_NAMES: Record<string, string> = {
  'transfer': 'Перевод токенов',
  'transferFrom': 'Перевод токенов (от имени)',
  'approve': 'Одобрение расходов',
  'withdrawETH': 'Вывод ETH',
  'depositETH': 'Депозит ETH',
  'borrowETH': 'Займ ETH',
  'repayETH': 'Погашение займа ETH',
  'supply': 'Депозит в пул',
  'withdraw': 'Вывод из пула',
  'wethDeposit': 'Врап ETH → WETH',
  'wethWithdraw': 'Анврап WETH → ETH',
  'borrow': 'Займ',
  'repay': 'Погашение займа',
  'exactInputSingle': 'Обмен токенов',
  'exactInput': 'Обмен токенов',
  'exactOutputSingle': 'Обмен токенов',
  'exactOutput': 'Обмен токенов',
  'multicall': 'Мультивызов',
  'execute': 'Выполнение',
  'swap': 'Обмен',
  'swapExactTokensForTokens': 'Обмен токенов',
  'swapTokensForExactTokens': 'Обмен токенов',
  'addLiquidity': 'Добавление ликвидности',
  'removeLiquidity': 'Удаление ликвидности',
  'stake': 'Стейкинг',
  'unstake': 'Анстейкинг',
  'claim': 'Получение награды',
  'claimRewards': 'Получение награды',
  'mint': 'Минт',
  'burn': 'Сжигание',

  'setPreSignature': 'Pre-sign ордер (CoW Swap)',
  'invalidateOrder': 'Отмена ордера (CoW Swap)',
  'settle': 'Исполнение ордера (CoW Swap)',

  'depositV3': 'Бридж через Across',
  'depositNative': 'Бридж через Across',
  'deposit': 'Бридж через Across',
  'swapAndBridge': 'Swap + Бридж через Across',
};

async function lookupSignature(selector: string): Promise<string | null> {
  if (signatureCache.has(selector)) {
    return signatureCache.get(selector) || null;
  }

  if (KNOWN_SIGNATURES[selector]) {
    signatureCache.set(selector, KNOWN_SIGNATURES[selector]);
    return KNOWN_SIGNATURES[selector];
  }

  if (isRedisAvailable()) {
    try {
      const cached = await redis.get(`${REDIS_SIG_PREFIX}${selector}`);
      if (cached !== null) {
        const sig = cached === '__null__' ? null : cached;
        signatureCache.set(selector, sig);
        return sig;
      }
    } catch {
    }
  }

  try {
    const response = await axios.get(
      `https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`,
      { timeout: 3000 }
    );

    if (response.data.results && response.data.results.length > 0) {
      const signature = response.data.results[0].text_signature;
      signatureCache.set(selector, signature);

      if (isRedisAvailable()) {
        redis.setex(`${REDIS_SIG_PREFIX}${selector}`, REDIS_SIG_TTL, signature).catch(() => {});
      }
      logger.debug({ selector, signature }, 'Found signature from 4byte');
      return signature;
    }
  } catch (error) {
    logger.debug({ selector, error }, 'Failed to lookup signature');
  }

  signatureCache.set(selector, null);

  if (isRedisAvailable()) {
    redis.setex(`${REDIS_SIG_PREFIX}${selector}`, REDIS_SIG_TTL, '__null__').catch(() => {});
  }
  return null;
}

function extractMethodName(signature: string): string {
  const match = signature.match(/^([a-zA-Z_][a-zA-Z0-9_]*)/);
  return match ? match[1] : signature;
}

const PROTOCOL_METHOD_DISPLAY: Record<string, Record<string, string>> = {
  'AAVE': {
    'supply': 'Депозит в Aave V3',
    'withdraw': 'Вывод из Aave V3',
    'borrow': 'Займ в Aave V3',
    'repay': 'Погашение займа Aave V3',
    'depositETH': 'Депозит ETH в Aave V3',
    'withdrawETH': 'Вывод ETH из Aave V3',
    'borrowETH': 'Займ ETH в Aave V3',
    'repayETH': 'Погашение займа ETH в Aave V3',
  },
  'Lido': {
    'submit': 'Стейкинг ETH в Lido',
    'requestWithdrawals': 'Запрос вывода из Lido',
    'claimWithdrawals': 'Получение вывода из Lido',
    'wrap': 'Врап stETH → wstETH',
    'unwrap': 'Анврап wstETH → stETH',
  },
  'Uniswap': {
    'exactInputSingle': 'Обмен токенов (Uniswap)',
    'exactInput': 'Обмен токенов (Uniswap)',
    'exactOutputSingle': 'Обмен токенов (Uniswap)',
    'exactOutput': 'Обмен токенов (Uniswap)',
    'multicall': 'Мультивызов Uniswap',
    'execute': 'Обмен через Uniswap',
  },
  'Uniswap V3': {
    'exactInputSingle': 'Обмен токенов (Uniswap)',
    'exactInput': 'Обмен токенов (Uniswap)',
    'exactOutputSingle': 'Обмен токенов (Uniswap)',
    'exactOutput': 'Обмен токенов (Uniswap)',
    'multicall': 'Мультивызов Uniswap',
  },
  'Uniswap Universal Router': {
    'execute': 'Обмен через Uniswap',
  },
  '1inch': {
    'swap': 'Обмен через 1inch',
    'unoswap': 'Обмен через 1inch',
    'fillOrder': 'Исполнение ордера 1inch',
  },
  'Curve': {
    'exchange': 'Обмен токенов (Curve)',
    'exchange_underlying': 'Обмен токенов (Curve)',
    'add_liquidity': 'Добавление ликвидности в Curve',
    'remove_liquidity': 'Удаление ликвидности из Curve',
  },
  'Compound': {
    'supply': 'Депозит в Compound V3',
    'withdraw': 'Вывод из Compound V3',
    'claim': 'Получение награды Compound',
  },
  'CoW Protocol': {
    'setPreSignature': 'Обмен через CoW Swap',
    'invalidateOrder': 'Отмена ордера CoW Swap',
    'settle': 'Исполнение CoW Settlement',
    'swap': 'Обмен через CoW Swap',
  },
  'WETH': {
    'wethDeposit': 'Врап ETH → WETH',
    'wethWithdraw': 'Анврап WETH → ETH',
  },
  'ERC20': {
    'transfer': 'Перевод токенов',
    'transferFrom': 'Перевод токенов (от имени)',
    'approve': 'Одобрение расходов',
  },
  'PancakeSwap': {
    'exactInputSingle': 'Обмен токенов (PancakeSwap)',
    'exactInput': 'Обмен токенов (PancakeSwap)',
    'exactOutputSingle': 'Обмен токенов (PancakeSwap)',
    'exactOutput': 'Обмен токенов (PancakeSwap)',
    'multicall': 'Мультивызов PancakeSwap',
    'execute': 'Обмен через PancakeSwap',
  },
  'SushiSwap': {
    'exactInputSingle': 'Обмен токенов (SushiSwap)',
    'exactInput': 'Обмен токенов (SushiSwap)',
    'multicall': 'Мультивызов SushiSwap',
    'execute': 'Обмен через SushiSwap',
  },
  'Across': {
    'depositV3': 'Бридж через Across',
    'depositNative': 'Бридж ETH через Across',
    'deposit': 'Бридж через Across',
    'swapAndBridge': 'Swap + Бридж через Across',
  },
};

export function getDisplayMethodName(methodName: string): string {
  return METHOD_DISPLAY_NAMES[methodName] || methodName;
}

export function getProtocolDisplayMethod(protocol: string, method: string): string | undefined {
  return PROTOCOL_METHOD_DISPLAY[protocol]?.[method];
}

export async function decodeSelector(data: string): Promise<{
  selector: string;
  signature: string | null;
  methodName: string;
  displayName: string;
}> {
  if (!data || data === '0x') {
    return {
      selector: '0x',
      signature: 'Native Transfer',
      methodName: 'transfer',
      displayName: 'Перевод ETH',
    };
  }

  const selector = data.slice(0, 10).toLowerCase();
  const signature = await lookupSignature(selector);

  if (signature) {
    const methodName = extractMethodName(signature);
    return {
      selector,
      signature,
      methodName,
      displayName: getDisplayMethodName(methodName),
    };
  }

  return {
    selector,
    signature: null,
    methodName: 'unknown',
    displayName: `Неизвестный метод (${selector})`,
  };
}

export async function decodeSelectorsBatch(selectors: string[]): Promise<Map<string, string | null>> {
  const results = new Map<string, string | null>();

  for (const selector of selectors) {
    const normalized = selector.toLowerCase();
    if (!results.has(normalized)) {
      results.set(normalized, await lookupSignature(normalized));
    }
  }

  return results;
}
