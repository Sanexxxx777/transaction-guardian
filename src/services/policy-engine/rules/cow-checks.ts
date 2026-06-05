import type { PolicyCheckInput, PolicyViolation } from '../../../models/policy.js';
import { getPriceFetcher, TOKEN_COINGECKO_IDS } from '../../price-fetcher/index.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('cow-checks');

export function checkCowCustomReceiver(input: PolicyCheckInput): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  if (!input.cowOrders) return out;

  for (const order of input.cowOrders) {
    if (!order.receiverIsSelf) {
      out.push({
        ruleId: 'COW_CUSTOM_RECEIVER',
        severity: 'danger',
        title: `CoW: получатель ≠ Safe`,
        description:
          `Купленные ${order.buySymbol} придут на адрес ${order.receiver}, ` +
          `а не на Safe ${input.transaction.from}. ` +
          `Возможна компрометация Safe UI или фишинговая подмена ордера. НЕ ПОДПИСЫВАТЬ.`,
        details: {
          uid: order.uid,
          receiver: order.receiver,
          safeAddress: input.transaction.from,
          buySymbol: order.buySymbol,
        },
      });
    }
  }
  return out;
}

export function checkCowApproveMismatch(input: PolicyCheckInput): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  if (!input.cowOrders || input.cowOrders.length === 0) return out;

  const params = input.decodedParams as {
    method?: string;
    tokenAddress?: string;
  } | undefined;
  if (!params || params.method !== 'approve' || !params.tokenAddress) return out;

  const approveToken = params.tokenAddress.toLowerCase();
  const sellTokens = new Set(input.cowOrders.map(o => o.sellTokenAddress.toLowerCase()));

  if (!sellTokens.has(approveToken)) {
    const sellSymbols = Array.from(new Set(input.cowOrders.map(o => o.sellSymbol))).join(', ');
    out.push({
      ruleId: 'COW_APPROVE_MISMATCH',
      severity: 'warning',
      title: 'CoW: approve не совпадает с sell-токеном',
      description:
        `В транзакции approve на ${approveToken}, но CoW ордер продаёт ${sellSymbols}. ` +
        `Подозрительная конфигурация — обычно UI делает approve именно на sell-токен.`,
      details: {
        approveTokenAddress: approveToken,
        sellTokenAddresses: Array.from(sellTokens),
      },
    });
  }
  return out;
}

export function checkCowOrderStatus(input: PolicyCheckInput): PolicyViolation[] {
  const out: PolicyViolation[] = [];
  if (!input.cowOrders) return out;

  for (const order of input.cowOrders) {
    if (!order.status) continue;
    const dead: Record<string, string> = {
      fulfilled: 'уже исполнен',
      cancelled: 'отменён',
      expired: 'истёк срок',
    };
    const label = dead[order.status];
    if (!label) continue;
    out.push({
      ruleId: 'COW_ORDER_DEAD',
      severity: 'info',
      title: `CoW ордер ${label}`,
      description:
        `Ордер ${order.uid.slice(0, 12)}… помечен в orderbook как "${order.status}". ` +
        `Подписывать бессмысленно — солвер его не возьмёт.`,
      details: { uid: order.uid, status: order.status },
    });
  }
  return out;
}

export async function checkCowPriceSanity(input: PolicyCheckInput): Promise<PolicyViolation[]> {
  const out: PolicyViolation[] = [];
  if (!input.cowOrders || input.cowOrders.length === 0) return out;

  const fetcher = getPriceFetcher();

  for (const order of input.cowOrders) {
    const sellSymUpper = order.sellSymbol.toUpperCase();
    const buySymUpper = order.buySymbol.toUpperCase();
    const STABLES = new Set(['USDC', 'USDT', 'DAI', 'USDC.E', 'USDBC', 'PYUSD', 'LUSD', 'FRAX']);

    let sellUsd: number | null = null;
    let buyUsd: number | null = null;

    if (STABLES.has(sellSymUpper)) sellUsd = 1;
    else if (TOKEN_COINGECKO_IDS[sellSymUpper]) {
      try { sellUsd = await fetcher.getPrice(sellSymUpper); } catch { }
    }

    if (STABLES.has(buySymUpper)) buyUsd = 1;
    else if (TOKEN_COINGECKO_IDS[buySymUpper]) {
      try { buyUsd = await fetcher.getPrice(buySymUpper); } catch { }
    }

    if (sellUsd == null || buyUsd == null) {
      logger.debug({ uid: order.uid, sellSymUpper, buySymUpper, sellUsd, buyUsd }, 'CoW price-sanity skipped (no spot price)');
      continue;
    }

    const sellNum = parseFloat(order.sellAmount);
    const buyNum = parseFloat(order.buyAmount);
    if (!isFinite(sellNum) || !isFinite(buyNum) || sellNum <= 0 || buyNum <= 0) continue;

    const orderUsdSell = sellNum * sellUsd;
    const orderUsdBuy = buyNum * buyUsd;

    const deviationPct = ((orderUsdBuy - orderUsdSell) / orderUsdSell) * 100;
    const absDev = Math.abs(deviationPct);

    if (deviationPct < -15) {
      out.push({
        ruleId: 'COW_PRICE_ANOMALY',
        severity: 'warning',
        title: `CoW: цена хуже рынка на ${absDev.toFixed(1)}%`,
        description:
          `Продаёшь ${order.sellAmount} ${order.sellSymbol} (~$${orderUsdSell.toFixed(2)}) ` +
          `за ${order.buyAmount} ${order.buySymbol} (~$${orderUsdBuy.toFixed(2)}). ` +
          `Это ${absDev.toFixed(1)}% хуже спота — возможно MEV-bait или ошибка котировки.`,
        details: { uid: order.uid, deviationPct, orderUsdSell, orderUsdBuy },
      });
    } else if (deviationPct < -5) {
      out.push({
        ruleId: 'COW_PRICE_ANOMALY',
        severity: 'info',
        title: `CoW: цена на ${absDev.toFixed(1)}% хуже спота`,
        description:
          `Лимит/рыночная цена ниже текущего спота на ${absDev.toFixed(1)}%. ` +
          `Если это рыночный ордер — приемлемое проскальзывание; если лимит — намеренная скидка.`,
        details: { uid: order.uid, deviationPct, orderUsdSell, orderUsdBuy },
      });
    } else if (deviationPct > 30) {
      out.push({
        ruleId: 'COW_PRICE_ANOMALY',
        severity: 'info',
        title: `CoW лимит на ${deviationPct.toFixed(1)}% выше спота`,
        description:
          `Лимит выгоднее текущего рынка на ${deviationPct.toFixed(1)}% — ` +
          `вероятно, ордер не исполнится в ближайшее время.`,
        details: { uid: order.uid, deviationPct, orderUsdSell, orderUsdBuy },
      });
    }
  }
  return out;
}
