
import axios from 'axios';
import { createLogger } from '../../utils/logger.js';
import type { AssetChange } from '../../models/transaction.js';
import { resolveToken } from '../token-resolver/index.js';

const logger = createLogger('cow-orderbook');

const FETCH_TIMEOUT_MS = 8000;

const CHAIN_TO_COW_ALIAS: Record<number, string> = {
  1: 'mainnet',
  100: 'xdai',
  42161: 'arbitrum_one',
  8453: 'base',
  137: 'polygon',
  11155111: 'sepolia',
};

const SET_PRE_SIGNATURE_SELECTOR = 'ec6cb13f';

const INVALIDATE_ORDER_SELECTOR = '2689f0a7';

const ORDER_UID_LENGTH_HEX = '38';

export interface CowOrder {
  uid: string;
  sellToken: string;
  buyToken: string;
  sellAmount: string;
  buyAmount: string;
  feeAmount: string;
  validTo: number;
  kind: 'sell' | 'buy';
  class?: 'market' | 'limit' | 'liquidity';
  receiver: string;
  partiallyFillable: boolean;
  status?: string;
}

export interface CowOrderInfo {
  uid: string;
  class: 'market' | 'limit' | 'liquidity';
  kind: 'sell' | 'buy';
  sellSymbol: string;
  buySymbol: string;
  sellTokenAddress: string;
  buyTokenAddress: string;
  sellAmountRaw: string;
  buyAmountRaw: string;
  sellAmount: string;
  buyAmount: string;
  sellDecimals: number;
  buyDecimals: number;
  validToTimestamp: number;
  receiver: string;
  receiverIsSelf: boolean;
  partiallyFillable: boolean;
  status?: string;

  cancelled?: boolean;
}

export function extractOrderUids(data: string): string[] {
  if (!data || data.length < 10) return [];
  const lower = data.toLowerCase().replace(/^0x/, '');
  const uids: string[] = [];
  const seen = new Set<string>();

  let pos = 0;
  while (true) {
    const idx = lower.indexOf(SET_PRE_SIGNATURE_SELECTOR, pos);
    if (idx === -1) break;
    pos = idx + SET_PRE_SIGNATURE_SELECTOR.length;

    const after = lower.slice(pos);
    if (after.length < 304) continue;

    const lengthField = after.slice(128, 192);
    if (lengthField !== ORDER_UID_LENGTH_HEX.padStart(64, '0')) continue;

    const uidHex = after.slice(192, 192 + 112);
    if (!/^[0-9a-f]{112}$/.test(uidHex)) continue;
    const uid = '0x' + uidHex;
    if (!seen.has(uid)) {
      seen.add(uid);
      uids.push(uid);
    }
  }

  return uids;
}

export function extractInvalidateOrderUids(data: string): string[] {
  if (!data || data.length < 10) return [];
  const lower = data.toLowerCase().replace(/^0x/, '');
  const uids: string[] = [];
  const seen = new Set<string>();

  let pos = 0;
  while (true) {
    const idx = lower.indexOf(INVALIDATE_ORDER_SELECTOR, pos);
    if (idx === -1) break;
    pos = idx + INVALIDATE_ORDER_SELECTOR.length;

    const after = lower.slice(pos);
    if (after.length < 240) continue;

    const lengthField = after.slice(64, 128);
    if (lengthField !== ORDER_UID_LENGTH_HEX.padStart(64, '0')) continue;

    const uidHex = after.slice(128, 128 + 112);
    if (!/^[0-9a-f]{112}$/.test(uidHex)) continue;
    const uid = '0x' + uidHex;
    if (!seen.has(uid)) {
      seen.add(uid);
      uids.push(uid);
    }
  }

  return uids;
}

export function getCowChainAlias(chainId: number): string | null {
  return CHAIN_TO_COW_ALIAS[chainId] || null;
}

export async function fetchCowOrder(chainId: number, orderUid: string): Promise<CowOrder | null> {
  const alias = getCowChainAlias(chainId);
  if (!alias) {
    logger.debug({ chainId }, 'CoW Orderbook does not support this chain');
    return null;
  }

  const url = `https://api.cow.fi/${alias}/api/v1/orders/${orderUid}`;
  const transientBackoffMs = [1000, 3000, 9000];
  let attempt404 = false;

  for (let i = 0; i <= transientBackoffMs.length; i++) {
    try {
      const response = await axios.get<CowOrder>(url, { timeout: FETCH_TIMEOUT_MS });
      return response.data;
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 404) {
          if (attempt404) {
            logger.info({ chainId, orderUid }, 'CoW order not found in orderbook after retry');
            return null;
          }

          attempt404 = true;
          logger.info({ chainId, orderUid }, 'CoW order 404 — waiting 3s for orderbook indexing');
          await new Promise(r => setTimeout(r, 3000));
          continue;
        }
        if (status && status >= 500) {
          if (i < transientBackoffMs.length) {
            const delay = transientBackoffMs[i];
            logger.warn({ chainId, orderUid, status, attempt: i + 1, delay }, 'CoW API 5xx — retrying');
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          logger.error({ chainId, orderUid, status }, 'CoW API 5xx exhausted retries');
          return null;
        }

        logger.warn({ error, chainId, orderUid, status }, 'CoW API error (non-retryable)');
        return null;
      }

      if (i < transientBackoffMs.length) {
        const delay = transientBackoffMs[i];
        logger.warn({ error, chainId, orderUid, attempt: i + 1, delay }, 'CoW network error — retrying');
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      logger.error({ error, chainId, orderUid }, 'CoW network error exhausted retries');
      return null;
    }
  }
  return null;
}

function rawToHuman(rawAmount: string, decimals: number): string {
  if (!/^\d+$/.test(rawAmount)) return '0';
  const raw = BigInt(rawAmount);
  const div = BigInt(10 ** decimals);
  const whole = raw / div;
  const frac = raw % div;
  const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6);
  return `${whole}.${fracStr}`.replace(/\.?0+$/, '') || '0';
}

export async function resolveCowOrders(
  chainId: number,
  data: string,
  safeAddress: string,
): Promise<{ assetChanges: AssetChange[]; orders: CowOrderInfo[]; unresolved: string[] }> {
  const createUids = extractOrderUids(data);
  const cancelUids = extractInvalidateOrderUids(data);
  if (createUids.length === 0 && cancelUids.length === 0) {
    return { assetChanges: [], orders: [], unresolved: [] };
  }

  const fetched = await Promise.all([
    ...createUids.map(uid => fetchCowOrder(chainId, uid).then(o => ({ order: o, cancelled: false as const }))),
    ...cancelUids.map(uid => fetchCowOrder(chainId, uid).then(o => ({ order: o, cancelled: true as const, uidFallback: uid }))),
  ]);

  const assetChanges: AssetChange[] = [];
  const orders: CowOrderInfo[] = [];
  const unresolvedSet = new Set<string>();
  const COW_PSEUDO_COUNTERPARTY = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';
  const safeLower = safeAddress.toLowerCase();

  for (const entry of fetched) {
    const order = entry.order;
    const isCancel = entry.cancelled;
    if (!order) {
      if (isCancel) {
        orders.push({
          uid: entry.uidFallback,
          class: 'limit',
          kind: 'sell',
          sellSymbol: '?', buySymbol: '?',
          sellTokenAddress: '0x0000000000000000000000000000000000000000',
          buyTokenAddress: '0x0000000000000000000000000000000000000000',
          sellAmountRaw: '0', buyAmountRaw: '0',
          sellAmount: '?', buyAmount: '?',
          sellDecimals: 18, buyDecimals: 18,
          validToTimestamp: 0,
          receiver: safeAddress,
          receiverIsSelf: true,
          partiallyFillable: false,
          cancelled: true,
        });
      }
      continue;
    }
    const [sellMeta, buyMeta] = await Promise.all([
      resolveToken(chainId, order.sellToken),
      resolveToken(chainId, order.buyToken),
    ]);
    if (!sellMeta) unresolvedSet.add(order.sellToken.toLowerCase());
    if (!buyMeta) unresolvedSet.add(order.buyToken.toLowerCase());

    const sellSymbol = sellMeta?.symbol || order.sellToken;
    const buySymbol = buyMeta?.symbol || order.buyToken;
    const sellDecimals = sellMeta?.decimals ?? 18;
    const buyDecimals = buyMeta?.decimals ?? 18;

    if (!isCancel) {
      assetChanges.push({
        type: 'erc20',
        tokenAddress: order.sellToken,
        tokenSymbol: sellSymbol,
        tokenDecimals: sellDecimals,
        from: safeAddress,
        to: COW_PSEUDO_COUNTERPARTY,
        amount: order.sellAmount,
      });
    }

    const receiver = order.receiver && order.receiver !== '0x0000000000000000000000000000000000000000'
      ? order.receiver
      : safeAddress;

    if (!isCancel) {
      assetChanges.push({
        type: 'erc20',
        tokenAddress: order.buyToken,
        tokenSymbol: buySymbol,
        tokenDecimals: buyDecimals,
        from: COW_PSEUDO_COUNTERPARTY,
        to: receiver,
        amount: order.buyAmount,
      });
    }

    orders.push({
      uid: order.uid,
      class: order.class || 'market',
      kind: order.kind,
      sellSymbol,
      buySymbol,
      sellTokenAddress: order.sellToken,
      buyTokenAddress: order.buyToken,
      sellAmountRaw: order.sellAmount,
      buyAmountRaw: order.buyAmount,
      sellAmount: rawToHuman(order.sellAmount, sellDecimals),
      buyAmount: rawToHuman(order.buyAmount, buyDecimals),
      sellDecimals,
      buyDecimals,
      validToTimestamp: order.validTo,
      receiver,
      receiverIsSelf: receiver.toLowerCase() === safeLower,
      partiallyFillable: order.partiallyFillable,
      status: order.status,
      cancelled: isCancel || undefined,
    });
  }

  return { assetChanges, orders, unresolved: Array.from(unresolvedSet) };
}

export async function resolveCowOrdersAsAssetChanges(
  chainId: number,
  data: string,
  safeAddress: string,
): Promise<AssetChange[]> {
  const { assetChanges } = await resolveCowOrders(chainId, data, safeAddress);
  return assetChanges;
}
