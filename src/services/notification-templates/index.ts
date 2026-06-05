import { escapeMarkdown, formatNumber } from '../../utils/formatters.js';
import { normalizeTokenSymbol } from '../../utils/token-symbols.js';
import { resolveToken } from '../token-resolver/index.js';
import { resolveContractName } from '../contract-resolver/index.js';
import { prisma } from '../../db/index.js';
import { getPriceFetcher, TOKEN_COINGECKO_IDS } from '../price-fetcher/index.js';
import { getSafeApiClient } from '../wallet-monitor/safe-api.js';
import { config } from '../../config/index.js';
import type { ProcessedTransaction } from '../../models/transaction.js';

export type OperationKind =
  | 'approve'
  | 'swap'
  | 'swap-cow'
  | 'swap-cow-limit'
  | 'cancel-cow-order'
  | 'bridge'
  | 'deposit'
  | 'deposit-lending'
  | 'deposit-staking'
  | 'withdraw'
  | 'borrow'
  | 'repay'
  | 'claim'
  | 'transfer-native'
  | 'transfer-erc20'
  | 'wrap'
  | 'unwrap'
  | 'safe-admin'
  | 'safe-admin-batch'
  | 'cancel'
  | 'multisend'
  | 'unknown';

export interface OperationTemplate {
  blockTitle: string | null;

  blockTree: string[];

  meaning: string | null;

  balanceOverride: string[] | null;

  skipProtocolLine: boolean;

  extraBlocks?: Array<{ title: string; rows: string[] }>;
}

interface BalanceMovement {
  symbol: string;
  decimals: number;

  netRaw: bigint;
  humanAbs: string;
  usdAbs: number | null;
  isPositive: boolean;
}

export interface OperationContext {
  movements: BalanceMovement[];
  outflows: BalanceMovement[];
  inflows: BalanceMovement[];

  resolvedNames: Map<string, string>;

  networkName: string;

  destinationChainName: string | null;

  protocolName: string | null;
}

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'USDE', 'USDS', 'TUSD', 'BUSD']);

const SWAP_PROTOCOLS = new Set([
  'Uniswap', 'Uniswap V2', 'Uniswap V3', 'Uniswap V4',
  '1inch', 'Curve', 'Balancer', 'Paraswap',
  'PancakeSwap', 'SushiSwap', 'Aerodrome', 'Velodrome',
  'Camelot', 'Trader Joe', 'GMX',
]);

const BRIDGE_PROTOCOLS = new Set([
  'Across', 'Stargate', 'LI.FI', 'Jumper (LI.FI)', 'Socket', 'Socket (Bungee)',
  'Bungee', 'Hop', 'Synapse', 'Wormhole', 'Gnosis Bridge', 'Connext',
]);

const LENDING_DEPOSIT_PROTOCOLS = new Set([
  'AAVE', 'Aave V3', 'Compound', 'Compound V3', 'Morpho',
  'Spark', 'Fluid', 'Instadapp Fluid Lite',
]);

const STAKING_PROTOCOLS = new Set([
  'Lido', 'Rocket Pool', 'KelpDAO', 'Pendle',
]);

const REWARD_PROTOCOLS = new Set([
  'Aura', 'Convex', 'Curve', 'Camelot',
]);

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 137: 'Polygon',
  8453: 'Base', 42161: 'Arbitrum', 43114: 'Avalanche', 59144: 'Linea',
  5000: 'Mantle', 324: 'zkSync',
};

export function detectOperationKind(tx: ProcessedTransaction, resolvedProtocol?: string | null): OperationKind {
  const params = tx.decodedParams as { method?: string } | null;
  const rawMethod = params?.method;

  const proto = tx.detectedProtocol || resolvedProtocol || null;
  const isSelfCall = tx.to.toLowerCase() === tx.walletAddress.toLowerCase();

  if (isSelfCall) {
    if (!tx.data || tx.data === '0x' || tx.data === '0x00') return 'cancel';
    return 'safe-admin';
  }

  const isNativeTransfer = (!tx.data || tx.data === '0x' || tx.data === '0x00')
    && tx.value && BigInt(tx.value) > 0n;
  if (isNativeTransfer) return 'transfer-native';

  if (proto === 'CoW Protocol' || (tx.cowOrders && tx.cowOrders.length > 0)) {
    const allCancels = !!(tx.cowOrders && tx.cowOrders.length > 0 && tx.cowOrders.every(o => o.cancelled));
    if (allCancels) return 'cancel-cow-order';

    if (tx.decodedMethod === 'invalidateOrder') return 'cancel-cow-order';
    if (tx.cowOrders && tx.cowOrders.some(o => o.class === 'limit')) return 'swap-cow-limit';
    return 'swap-cow';
  }

  if (rawMethod === 'approve') return 'approve';
  if (rawMethod === 'transfer' || rawMethod === 'transferFrom') return 'transfer-erc20';
  if (rawMethod === 'wethDeposit') return 'wrap';
  if (rawMethod === 'wethWithdraw') return 'unwrap';

  if (proto && BRIDGE_PROTOCOLS.has(proto)) return 'bridge';
  if (tx.destinationChainId) return 'bridge';

  if (rawMethod === 'supply' || rawMethod === 'depositETH'
      || (rawMethod === 'deposit' && proto && (LENDING_DEPOSIT_PROTOCOLS.has(proto) || proto.includes('Aave')))) {
    return 'deposit-lending';
  }
  if (proto && LENDING_DEPOSIT_PROTOCOLS.has(proto) && rawMethod === 'mint') {
    return 'deposit-lending';
  }

  if (rawMethod === 'submit' || rawMethod === 'stake') {
    return 'deposit-staking';
  }

  if (rawMethod === 'add_liquidity' || rawMethod === 'mint') {
    return 'deposit';
  }
  if (rawMethod === 'withdraw' || rawMethod === 'withdrawETH' || rawMethod === 'redeem'
      || rawMethod === 'unstake' || rawMethod === 'remove_liquidity'
      || rawMethod === 'remove_liquidity_one_coin') {
    return 'withdraw';
  }
  if (rawMethod === 'borrow' || rawMethod === 'borrowETH') return 'borrow';
  if (rawMethod === 'repay' || rawMethod === 'repayETH') return 'repay';
  if (rawMethod && /claim/i.test(rawMethod)) return 'claim';

  if (proto && SWAP_PROTOCOLS.has(proto)) return 'swap';
  if (rawMethod && (
    rawMethod.includes('swap') || rawMethod.includes('Swap')
    || rawMethod.startsWith('exactInput') || rawMethod.startsWith('exactOutput')
    || rawMethod === 'exchange' || rawMethod === 'exchange_underlying'
    || rawMethod === 'unoswap' || rawMethod === 'unoswapTo'
    || rawMethod === 'multicall'
  )) {
    return 'swap';
  }

  if (proto && LENDING_DEPOSIT_PROTOCOLS.has(proto)) return 'deposit-lending';
  if (proto && STAKING_PROTOCOLS.has(proto)) return 'deposit-staking';

  if (proto && REWARD_PROTOCOLS.has(proto) && rawMethod && /reward|harvest/i.test(rawMethod)) {
    return 'claim';
  }

  if (tx.multiSendInnerCalls && tx.multiSendInnerCalls.length >= 1) {
    const allSafeAdmin = tx.multiSendInnerCalls.every(c =>
      c.protocol === 'Safe' && c.to.toLowerCase() === tx.walletAddress.toLowerCase()
    );
    if (allSafeAdmin) return 'safe-admin-batch';
    if (tx.multiSendInnerCalls.length > 1) return 'multisend';
  }

  return 'unknown';
}

export async function buildOperationContext(
  tx: ProcessedTransaction,
  resolvedProtocol?: string | null,
): Promise<OperationContext> {
  const movements = await computeBalanceMovements(tx);
  const outflows = movements.filter(m => !m.isPositive);
  const inflows = movements.filter(m => m.isPositive);

  const networkName = CHAIN_NAMES[tx.chainId] || `Chain ${tx.chainId}`;

  let destinationChainName: string | null = null;
  if (tx.destinationChainId) {
    destinationChainName = CHAIN_NAMES[tx.destinationChainId] || `Chain ${tx.destinationChainId}`;
  }

  return {
    movements,
    outflows,
    inflows,
    resolvedNames: new Map(),
    networkName,
    destinationChainName,
    protocolName: tx.detectedProtocol || resolvedProtocol || null,
  };
}

async function computeBalanceMovements(tx: ProcessedTransaction): Promise<BalanceMovement[]> {
  const sim = tx.simulationResult;
  if (!sim?.assetChanges || sim.assetChanges.length === 0) return [];

  const safeLower = tx.walletAddress.toLowerCase();
  const netMap = new Map<string, { symbol: string; decimals: number; netRaw: bigint }>();

  for (const change of sim.assetChanges) {
    const symbol = normalizeTokenSymbol(change.tokenSymbol);
    const decimals = change.tokenDecimals || 18;
    if (!netMap.has(symbol)) {
      netMap.set(symbol, { symbol, decimals, netRaw: 0n });
    }
    const entry = netMap.get(symbol)!;
    const rawAmount = /^\d+$/.test(change.amount || '0') ? BigInt(change.amount || '0') : 0n;
    const isOut = change.from && change.from.toLowerCase() === safeLower;
    const isIn = change.to && change.to.toLowerCase() === safeLower;
    if (isOut && !isIn) entry.netRaw -= rawAmount;
    else if (isIn && !isOut) entry.netRaw += rawAmount;
  }

  const significant = Array.from(netMap.values()).filter(e => e.netRaw !== 0n);

  const priceFetcher = getPriceFetcher();
  const movements: BalanceMovement[] = [];
  for (const entry of significant) {
    const isPositive = entry.netRaw > 0n;
    const abs = isPositive ? entry.netRaw : -entry.netRaw;
    const divisor = 10n ** BigInt(entry.decimals);
    const whole = abs / divisor;
    const fraction = abs % divisor;
    const fractionStr = fraction.toString().padStart(entry.decimals, '0').slice(0, 6);
    const humanAbs = `${whole}.${fractionStr}`.replace(/\.?0+$/, '') || '0';

    let usdAbs: number | null = null;
    if (STABLECOINS.has(entry.symbol)) {
      usdAbs = Number(humanAbs);
    } else if (TOKEN_COINGECKO_IDS[entry.symbol]) {
      try {
        const price = await priceFetcher.getPrice(entry.symbol);
        if (price !== null) {
          usdAbs = Number(humanAbs) * price;
        }
      } catch { }
    }

    movements.push({
      symbol: entry.symbol,
      decimals: entry.decimals,
      netRaw: entry.netRaw,
      humanAbs,
      usdAbs,
      isPositive,
    });
  }
  return movements;
}

async function dbProtocolName(address: string, chainId: number): Promise<string | null> {
  try {
    const protocols = await prisma.protocolWhitelist.findMany({
      where: { isActive: true },
      select: { protocolName: true, contractAddresses: true },
    });
    const lower = address.toLowerCase();
    for (const p of protocols) {
      const map = p.contractAddresses as Record<string, string[]>;
      const addrs = map[chainId.toString()] || [];
      if (addrs.some(a => a.toLowerCase() === lower)) return p.protocolName;
    }
  } catch { }
  return null;
}

async function dbAddressLabel(address: string, chainId: number): Promise<string | null> {
  try {
    const entries = await prisma.addressWhitelist.findMany({
      where: {
        address: { equals: address, mode: 'insensitive' },
        isActive: true,
      },
      select: { label: true, chainIds: true },
    });
    for (const e of entries) {
      const chainOk = !e.chainIds || e.chainIds.length === 0 || e.chainIds.includes(chainId);
      if (chainOk && e.label) return e.label;
    }
  } catch { }
  return null;
}

async function resolveAddressName(address: string, chainId: number): Promise<string | null> {
  const dbName = await dbProtocolName(address, chainId);
  if (dbName) return dbName;
  const addrLabel = await dbAddressLabel(address, chainId);
  if (addrLabel) return addrLabel;
  return await resolveContractName(address, chainId);
}

function fmtAmount(symbol: string, humanAmount: string, usd: number | null): string {
  let line = `${escapeMarkdown(humanAmount)} ${escapeMarkdown(symbol)}`;
  if (usd !== null) {
    line += ` \\(${escapeMarkdown('$' + formatNumber(usd, 2))}\\)`;
  }
  return line;
}

function fmtSignedAmount(m: BalanceMovement): string {
  const sign = m.isPositive ? '\\+' : '\\-';
  let line = `${sign}${escapeMarkdown(m.humanAbs)} ${escapeMarkdown(m.symbol)}`;
  if (m.usdAbs !== null) {
    line += ` \\(${sign}${escapeMarkdown('$' + formatNumber(m.usdAbs, 2))}\\)`;
  }
  return line;
}

function code(text: string): string {
  return '`' + text.replace(/`/g, '') + '`';
}

function emptyTemplate(): OperationTemplate {
  return {
    blockTitle: null,
    blockTree: [],
    meaning: null,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

async function approveTemplate(tx: ProcessedTransaction): Promise<OperationTemplate> {
  const params = tx.decodedParams as { spender?: string; amount?: bigint | string; isUnlimited?: boolean; tokenAddress?: string } | null;
  if (!params?.spender) return emptyTemplate();

  const tokenAddr = params.tokenAddress || tx.to;
  const spenderAddr = params.spender;

  const tokenInfo = await resolveToken(tx.chainId, tokenAddr);
  const tokenSymbol = tokenInfo?.symbol
    || (await dbProtocolName(tokenAddr, tx.chainId))
    || 'токен';
  const tokenDecimals = tokenInfo?.decimals ?? 18;

  const spenderName = await resolveAddressName(spenderAddr, tx.chainId);

  let isRevoke = false;
  let limitDisplay: string;
  if (params.isUnlimited) {
    limitDisplay = 'безлимитный';
  } else if (params.amount !== undefined && params.amount !== null) {
    try {
      const amt = typeof params.amount === 'bigint' ? params.amount : BigInt(params.amount);
      isRevoke = amt === 0n;
      const divisor = 10n ** BigInt(tokenDecimals);
      const whole = amt / divisor;
      const fraction = amt % divisor;
      const fractionStr = fraction.toString().padStart(tokenDecimals, '0').slice(0, 6);
      const human = `${whole}.${fractionStr}`.replace(/\.?0+$/, '') || '0';
      limitDisplay = `${human} ${tokenSymbol}`;
    } catch {
      limitDisplay = String(params.amount);
    }
  } else {
    limitDisplay = '?';
  }

  const tree: string[] = [
    `Токен: ${escapeMarkdown(tokenSymbol)}`,
    `Лимит: ${escapeMarkdown(limitDisplay)}`,
  ];
  if (spenderName) {
    tree.push(`Получатель: ${escapeMarkdown(spenderName)}`);
    tree.push(`Адрес: ${code(spenderAddr)}`);
  } else {
    tree.push(`Получатель: ${code(spenderAddr)}`);
  }

  const spenderText = spenderName ? escapeMarkdown(spenderName) : 'указанному контракту';
  const meaning = isRevoke
    ? `Подписав транзакцию, вы *отзываете* ранее выданное разрешение ${spenderText} на списание ${escapeMarkdown(tokenSymbol)}\\. `
      + `После исполнения этот контракт больше не сможет тратить ваши ${escapeMarkdown(tokenSymbol)} с этого кошелька — `
      + `пока вы снова не выдадите approve\\.`
    : `Подписав транзакцию, вы разрешите ${spenderText} списывать ваш ${escapeMarkdown(tokenSymbol)} `
      + `при будущих операциях \\(свопы, бриджи, депозиты\\)\\. `
      + `Сами токены остаются на кошельке до их фактического использования\\.`;

  return {
    blockTitle: isRevoke
      ? '🚫 *Отзыв доступа \\(Revoke\\)*'
      : '🔓 *Разрешение токена \\(Approve\\)*',
    blockTree: tree,
    meaning,
    balanceOverride: isRevoke
      ? ['Не изменится — операция только отменяет ранее выданный approve']
      : ['Сейчас не изменится — Approve выдаёт разрешение, токены не списываются'],
    skipProtocolLine: true,
  };
}

function swapTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'DEX';

  const tree: string[] = [];
  if (out) tree.push(`Отдаёте: ${fmtAmount(out.symbol, out.humanAbs, out.usdAbs)}`);
  if (inn) tree.push(`Получаете: ${fmtAmount(inn.symbol, inn.humanAbs, inn.usdAbs)}`);

  if (out && inn) {
    const outNum = Number(out.humanAbs);
    const inNum = Number(inn.humanAbs);
    if (outNum > 0 && inNum > 0) {
      const rate = inNum / outNum;
      const ratePretty = rate >= 1
        ? formatNumber(rate, 6).replace(/\.?0+$/, '')
        : rate.toFixed(8).replace(/\.?0+$/, '');
      tree.push(`Курс: 1 ${escapeMarkdown(out.symbol)} ≈ ${escapeMarkdown(ratePretty)} ${escapeMarkdown(inn.symbol)}`);
    }
  }

  const meaning = out && inn
    ? `Вы меняете ${escapeMarkdown(out.symbol)} на ${escapeMarkdown(inn.symbol)} через ${escapeMarkdown(proto)}\\. `
      + `Точная сумма зависит от курса в момент исполнения\\. Заложен минимальный порог: если цена резко уйдёт `
      + `\\(проскальзывание\\), сделка отменится — но не исполнится по плохому курсу\\.`
    : `Это операция обмена токенов через ${escapeMarkdown(proto)}\\. `
      + `Точная сумма получения зависит от курса в момент исполнения\\.`;

  return {
    blockTitle: '🔄 *Обмен токенов \\(Swap\\)*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function bridgeTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const proto = ctx.protocolName || 'мост';
  const dst = ctx.destinationChainName;
  const recipIsSelf = tx.detectedRecipient
    ? tx.detectedRecipient.toLowerCase() === tx.walletAddress.toLowerCase()
    : null;

  const tree: string[] = [];
  if (out) tree.push(`Отдаёте: ${fmtAmount(out.symbol, out.humanAbs, out.usdAbs)}`);
  if (dst) tree.push(`На сеть: ${escapeMarkdown(dst)}`);
  if (recipIsSelf === true) {
    tree.push('Получатель: тот же кошелёк ✓');
  } else if (recipIsSelf === false && tx.detectedRecipient) {
    tree.push(`Получатель: ${code(tx.detectedRecipient)} \\(не ваш кошелёк\\)`);
  }

  const dstText = dst ? `в сеть ${escapeMarkdown(dst)}` : 'в другую сеть';
  const meaning = out
    ? `Бридж — это перевод средств между разными блокчейн\\-сетями\\. ${escapeMarkdown(out.humanAbs)} ${escapeMarkdown(out.symbol)} уйдут ${dstText} через ${escapeMarkdown(proto)} `
      + `и появятся там через несколько минут\\. Часть суммы уйдёт на комиссию протокола \\(она уже учтена в курсе\\)\\.`
    : `Бридж — это перевод средств между разными блокчейн\\-сетями\\. Активы уйдут ${dstText} через ${escapeMarkdown(proto)} `
      + `и появятся там через несколько минут\\.`;

  return {
    blockTitle: '🌉 *Бридж в другую сеть*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function depositTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (out) tree.push(`Вносите: ${fmtAmount(out.symbol, out.humanAbs, out.usdAbs)}`);
  if (inn) tree.push(`Получаете: ${escapeMarkdown(inn.humanAbs)} ${escapeMarkdown(inn.symbol)} \\(LP\\-токен\\)`);

  const meaning = out
    ? `Вы вносите ${escapeMarkdown(out.symbol)} в пул ${escapeMarkdown(proto)}\\. `
      + `Взамен получаете LP\\-токен — учётную запись о вашей доле в пуле\\. `
      + `Доход — комиссии трейдеров, минус impermanent loss при сильном движении цены\\.`
    : `Вы вносите средства в пул ${escapeMarkdown(proto)} и получаете LP\\-токен \\(долю в пуле\\)\\.`;

  return {
    blockTitle: '🏦 *Депозит в пул ликвидности*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function depositLendingTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (out) tree.push(`Вносите: ${fmtAmount(out.symbol, out.humanAbs, out.usdAbs)}`);
  if (inn) tree.push(`Получаете: ${escapeMarkdown(inn.humanAbs)} ${escapeMarkdown(inn.symbol)} \\(учётный токен\\)`);

  const assetSym = out ? escapeMarkdown(out.symbol) : 'актив';
  const meaning = out
    ? `Вы вносите ${escapeMarkdown(out.humanAbs)} ${assetSym} в кредитный пул ${escapeMarkdown(proto)}\\. `
      + `Актив одолжат другие пользователи под проценты — часть процентов придёт вам, ставка плавающая\\. `
      + `Взамен получаете учётный токен \\(${inn ? escapeMarkdown(inn.symbol) : 'a\\-токен'}\\), его баланс растёт сам по мере начисления\\. `
      + `Вывести можно когда угодно — но только если в пуле есть свободный ${assetSym} \\(если всё одолжено, ждёте возврата\\)\\.`
    : `Вы вносите средства в кредитный пул ${escapeMarkdown(proto)}\\. Актив будут занимать другие пользователи под проценты, часть из них вернётся вам\\.`;

  return {
    blockTitle: '🏦 *Депозит в кредитный пул*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function depositStakingTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (out) tree.push(`Стейкаете: ${fmtAmount(out.symbol, out.humanAbs, out.usdAbs)}`);
  if (inn) tree.push(`Получаете: ${escapeMarkdown(inn.humanAbs)} ${escapeMarkdown(inn.symbol)}`);

  const recvSym = inn ? escapeMarkdown(inn.symbol) : 'ликвидный токен';
  const meaning = out
    ? `Вы стейкаете ${escapeMarkdown(out.humanAbs)} ${escapeMarkdown(out.symbol)} в ${escapeMarkdown(proto)}\\. `
      + `Актив идёт валидаторам сети — они подтверждают блоки и получают за это награды, часть приходит вам\\. `
      + `Взамен получаете ${recvSym} — это ликвидный токен, его можно держать, использовать в DeFi или продать\\. `
      + `Прямой анстейк через UI протокола занимает несколько дней; быстрее обменять ${recvSym} на исходный актив через DEX\\.`
    : `Вы стейкаете средства в ${escapeMarkdown(proto)} и получаете ликвидный токен \\(${recvSym}\\)\\.`;

  return {
    blockTitle: '🏦 *Стейкинг*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function withdrawTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (out) tree.push(`Сжигаете: ${escapeMarkdown(out.humanAbs)} ${escapeMarkdown(out.symbol)}`);
  if (inn) tree.push(`Получаете: ${fmtAmount(inn.symbol, inn.humanAbs, inn.usdAbs)}`);

  const meaning = inn
    ? `Вы выводите ${escapeMarkdown(inn.symbol)} из ${escapeMarkdown(proto)}, обменивая внутренние токены\\-расписки обратно на актив\\. `
      + `Накопленные проценты автоматически включены в сумму вывода\\.`
    : `Вы выводите средства из ${escapeMarkdown(proto)}\\.`;

  return {
    blockTitle: '🏧 *Вывод из протокола*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function borrowTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (inn) tree.push(`Заёмная сумма: ${fmtAmount(inn.symbol, inn.humanAbs, inn.usdAbs)}`);

  const meaning = inn
    ? `Вы берёте ${escapeMarkdown(inn.symbol)} в долг под залог уже внесённых активов в ${escapeMarkdown(proto)}\\. `
      + `Долг растёт со временем по плавающей ставке\\.`
    : `Вы берёте средства в долг под залог в ${escapeMarkdown(proto)}\\.`;

  return {
    blockTitle: '💳 *Заём \\(Borrow\\)*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function repayTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (out) tree.push(`Возвращаете: ${fmtAmount(out.symbol, out.humanAbs, out.usdAbs)}`);

  const meaning = `Вы погашаете долг в ${escapeMarkdown(proto)}\\. `
    + `Показатель здоровья позиции \\(Health Factor\\) вырастет — снизится риск автоматической ликвидации залога, `
    + `а сам залог можно будет частично или полностью вывести\\.`;

  return {
    blockTitle: '💵 *Погашение долга \\(Repay\\)*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function claimTemplate(tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const inn = ctx.inflows[0];
  const proto = ctx.protocolName || 'протокол';

  const tree: string[] = [];
  if (inn) tree.push(`Получаете: ${fmtAmount(inn.symbol, inn.humanAbs, inn.usdAbs)}`);

  const meaning = `Вы забираете накопленные награды из ${escapeMarkdown(proto)}\\. `
    + `Это безопасная операция — она только переводит ваши же начисления на кошелёк\\.`;

  return {
    blockTitle: '🎁 *Получение наград \\(Claim\\)*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

async function transferNativeTemplate(tx: ProcessedTransaction, ctx: OperationContext): Promise<OperationTemplate> {
  const recipient = tx.to;
  const recipientName = await resolveAddressName(recipient, tx.chainId);
  const nativeSymbol = ctx.networkName === 'BNB Chain' ? 'BNB'
    : ctx.networkName === 'Polygon' ? 'POL'
    : ctx.networkName === 'Avalanche' ? 'AVAX'
    : 'ETH';

  const meaning = `Это прямой перевод ${nativeSymbol} с вашего кошелька на указанный адрес\\. `
    + `Транзакция необратима: после исполнения вернуть средства без участия получателя нельзя\\.`;

  if (!recipientName) {
    return {
      blockTitle: null,
      blockTree: [],
      meaning,
      balanceOverride: null,
      skipProtocolLine: true,
    };
  }

  return {
    blockTitle: '💸 *Прямой перевод*',
    blockTree: [`Получатель: ${escapeMarkdown(recipientName)}`],
    meaning,
    balanceOverride: null,
    skipProtocolLine: true,
  };
}

async function transferErc20Template(tx: ProcessedTransaction, ctx: OperationContext): Promise<OperationTemplate> {
  const recipient = tx.detectedRecipient || tx.to;
  const recipientName = await resolveAddressName(recipient, tx.chainId);

  let symbol: string | null = null;
  if (ctx.outflows[0]) {
    symbol = ctx.outflows[0].symbol;
  } else {
    const tokenInfo = await resolveToken(tx.chainId, tx.to);
    if (tokenInfo) symbol = tokenInfo.symbol;
  }
  const tokenLabel = symbol || 'токенов';
  const meaning = `Это прямой перевод ${escapeMarkdown(tokenLabel)} на указанный адрес\\. `
    + `Транзакция необратима: после исполнения вернуть средства без участия получателя нельзя\\.`;

  if (!recipientName) {
    return {
      blockTitle: null,
      blockTree: [],
      meaning,
      balanceOverride: null,
      skipProtocolLine: true,
    };
  }

  return {
    blockTitle: '💸 *Перевод токена*',
    blockTree: [`Получатель: ${escapeMarkdown(recipientName)}`],
    meaning,
    balanceOverride: null,
    skipProtocolLine: true,
  };
}

function wrapTemplate(_tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const tree: string[] = [];
  if (out) tree.push(`Отдаёте: ${escapeMarkdown(out.humanAbs)} ${escapeMarkdown(out.symbol)}`);
  if (inn) tree.push(`Получаете: ${escapeMarkdown(inn.humanAbs)} ${escapeMarkdown(inn.symbol)}`);

  const meaning = `WETH — это ERC20\\-версия ETH\\. `
    + `Нативный ETH нельзя использовать в смарт\\-контрактах \\(DEX, лендинг\\) напрямую, поэтому его «оборачивают» в стандарт ERC20\\. `
    + `Соотношение всегда 1:1 — это не своп\\.`;

  return {
    blockTitle: '🧧 *Wrap ETH → WETH*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

function unwrapTemplate(_tx: ProcessedTransaction, ctx: OperationContext): OperationTemplate {
  const out = ctx.outflows[0];
  const inn = ctx.inflows[0];
  const tree: string[] = [];
  if (out) tree.push(`Отдаёте: ${escapeMarkdown(out.humanAbs)} ${escapeMarkdown(out.symbol)}`);
  if (inn) tree.push(`Получаете: ${escapeMarkdown(inn.humanAbs)} ${escapeMarkdown(inn.symbol)}`);

  const meaning = `Unwrap превращает WETH обратно в нативный ETH\\. `
    + `Соотношение 1:1\\. После исполнения ETH можно использовать для оплаты газа или прямых переводов\\.`;

  return {
    blockTitle: '🧨 *Unwrap WETH → ETH*',
    blockTree: tree,
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

interface SafeState {
  owners: string[];
  threshold: number;
}

interface SafeAdminOp {
  method: string;
  params: Record<string, unknown> | null | undefined;
}

async function fetchSafeState(safeAddress: string, chainId: number): Promise<SafeState | null> {
  try {
    const network = await prisma.network.findUnique({ where: { chainId } });
    if (!network) return null;
    const client = getSafeApiClient(chainId, network.safeTxServiceUrl, config.safe.apiKey || undefined);
    const info = await client.getSafeInfo(safeAddress);
    if (!info?.owners) return null;
    return { owners: info.owners, threshold: info.threshold ?? 0 };
  } catch {
    return null;
  }
}

function projectSafeState(state: SafeState, ops: SafeAdminOp[]): SafeState {
  let owners = [...state.owners];
  let threshold = state.threshold;
  for (const { method, params } of ops) {
    const p = (params || {}) as Record<string, unknown>;
    switch (method) {
      case 'addOwnerWithThreshold': {
        const newOwner = String(p.owner || '');
        if (newOwner && !owners.some(o => o.toLowerCase() === newOwner.toLowerCase())) {
          owners = [newOwner, ...owners];
        }
        threshold = Number(p.threshold) || threshold;
        break;
      }
      case 'removeOwner': {
        const target = String(p.owner || '').toLowerCase();
        owners = owners.filter(o => o.toLowerCase() !== target);
        threshold = Number(p.threshold) || threshold;
        break;
      }
      case 'swapOwner': {
        const oldO = String(p.oldOwner || '').toLowerCase();
        const newO = String(p.newOwner || '');
        const idx = owners.findIndex(o => o.toLowerCase() === oldO);
        if (idx >= 0 && newO) owners[idx] = newO;
        break;
      }
      case 'changeThreshold': {
        threshold = Number(p.threshold) || threshold;
        break;
      }
    }
  }
  return { owners, threshold };
}

function shortAddrCode(a: string): string {
  return `\`${a.slice(0, 6)}…${a.slice(-4)}\``;
}

async function buildSafeStatePreviewBlock(
  tx: ProcessedTransaction,
  ops: SafeAdminOp[],
): Promise<{ title: string; rows: string[] } | null> {
  const before = await fetchSafeState(tx.walletAddress, tx.chainId);
  if (!before) return null;
  const after = projectSafeState(before, ops);

  const beforeLower = new Set(before.owners.map(o => o.toLowerCase()));
  const afterLower = new Set(after.owners.map(o => o.toLowerCase()));

  const rows: string[] = [];

  for (const o of after.owners) {
    const isNew = !beforeLower.has(o.toLowerCase());
    rows.push(isNew ? `${shortAddrCode(o)} ➕` : shortAddrCode(o));
  }

  const removed = before.owners.filter(o => !afterLower.has(o.toLowerCase()));
  for (const o of removed) {
    rows.push(`Перестаёт быть владельцем: ${shortAddrCode(o)} ➖`);
  }
  rows.push(`Порог: *${after.threshold}* из ${after.owners.length}`);

  return {
    title: '📋 *Состав Safe после исполнения:*',
    rows,
  };
}

async function safeAdminTemplate(tx: ProcessedTransaction): Promise<OperationTemplate> {
  const method = tx.decodedMethod || 'управление Safe';
  const params = tx.decodedParams as { method?: string } & Record<string, unknown> | null;

  const tree: string[] = [
    `Действие: ${escapeMarkdown(method)}`,
  ];

  const renderAddress = async (addr: string): Promise<string> => {
    const name = await resolveAddressName(addr, tx.chainId);
    return name ? `${escapeMarkdown(name)} \\(${code(addr)}\\)` : code(addr);
  };

  let meaning: string;

  if (params?.method === 'addOwnerWithThreshold') {
    const owner = String(params.owner);
    const threshold = Number(params.threshold);
    tree.push(`Новый владелец: ${await renderAddress(owner)}`);
    tree.push(`Новый порог: ${threshold}`);
    meaning =
      `Вы добавляете новый адрес в число подписантов кошелька\\. `
      + `Этот адрес сможет голосовать за транзакции наравне с остальными владельцами, `
      + `а порог подписей станет ${threshold}\\. `
      + `Убедитесь, что адрес действительно принадлежит доверенному человеку — отозвать его потом можно только новой транзакцией с подписями текущих владельцев\\.`;
  } else if (params?.method === 'removeOwner') {
    const owner = String(params.owner);
    const threshold = Number(params.threshold);
    tree.push(`Удаляется: ${await renderAddress(owner)}`);
    tree.push(`Новый порог: ${threshold}`);
    meaning =
      `Указанный адрес перестанет быть владельцем кошелька — он не сможет ни подписывать транзакции, ни голосовать за их исполнение\\. `
      + `Если адрес хранится у конкретного человека, обязательно уведомьте его\\. `
      + `Восстановить право подписи можно только повторным добавлением через addOwner с подписями оставшихся владельцев\\.`;
  } else if (params?.method === 'swapOwner') {
    const oldOwner = String(params.oldOwner);
    const newOwner = String(params.newOwner);
    tree.push(`Заменяется: ${await renderAddress(oldOwner)}`);
    tree.push(`На нового: ${await renderAddress(newOwner)}`);
    meaning =
      `Один владелец заменяется другим в одной операции — старый адрес теряет право подписи, новый получает\\. `
      + `Это эквивалентно последовательной removeOwner \\+ addOwner, но за одну транзакцию\\. `
      + `Проверьте, что новый адрес — действительно тот, кому вы хотите передать роль владельца\\.`;
  } else if (params?.method === 'changeThreshold') {
    const threshold = Number(params.threshold);
    tree.push(`Новый порог: ${threshold}`);
    meaning =
      `Меняется количество подписей, нужное для исполнения любой транзакции с этого кошелька — теперь будет требоваться ${threshold}\\. `
      + `Снижение порога ускоряет операции, но увеличивает риск: если ключ одного из подписантов будет скомпрометирован, средствами могут распорядиться без согласия остальных\\. `
      + `Повышение наоборот — замедляет работу, зато требует согласия большего числа владельцев\\.`;
  } else if (params?.method === 'enableModule') {
    const module = String(params.module);
    tree.push(`Модуль: ${await renderAddress(module)}`);
    meaning =
      `Модуль — это контракт, которому вы даёте право *исполнять транзакции с этого кошелька без подписей владельцев*\\. `
      + `Это удобно для автоматизации \\(рекуррентные платежи, лимит\\-ордера, recovery\\), но опасно: если в модуле есть баг или его контракт скомпрометирован, средства могут быть украдены без необходимости что\\-либо подписывать\\. `
      + `Включайте только проверенные модули с открытым исходным кодом и аудитом\\.`;
  } else if (params?.method === 'disableModule') {
    const module = String(params.module);
    tree.push(`Отключается модуль: ${await renderAddress(module)}`);
    meaning =
      `Указанный модуль теряет право исполнять транзакции с этого кошелька в обход подписей владельцев\\. `
      + `Это безопасная операция — она лишь ограничивает возможности модуля, ничего нового не разрешает\\. `
      + `Если модуль использовался для автоматизации \\(рекуррентные платежи и т\\.п\\.\\), эта функция перестанет работать после исполнения\\.`;
  } else if (params?.method === 'setGuard') {
    const guard = String(params.guard);
    const isReset = /^0x0+$/.test(guard);
    tree.push(`Guard: ${isReset ? 'сбрасывается \\(0x0\\)' : await renderAddress(guard)}`);
    meaning = isReset
      ? `Дополнительный контроль guard перед/после транзакций больше не применяется — кошелёк возвращается к стандартному поведению Safe\\. `
        + `Если guard использовался для защиты \\(например, лимиты, whitelist получателей\\), эти ограничения снимаются\\.`
      : `Guard — контракт, который вызывается до и после каждой транзакции этого кошелька и может её отклонить или провести дополнительную проверку \\(лимиты, whitelist и т\\.п\\.\\)\\. `
        + `Полезный инструмент защиты, но если в guard ошибка — *все транзакции могут оказаться заблокированы* и расблокировать их можно будет только сменой guard\\. `
        + `Используйте только проверенные guard\\-контракты с аудитом\\.`;
  } else if (params?.method === 'approveHash') {
    const hash = String(params.hash);
    tree.push(`Подписываемый хэш: ${code(hash.slice(0, 18) + '…')}`);
    meaning =
      `Это часть стандартного процесса подписи Safe\\-транзакции — один из владельцев подтверждает заранее посчитанный хэш будущей транзакции on\\-chain\\. `
      + `Сама транзакция, на которую идёт подпись, не выполняется этой операцией; она исполнится отдельно, когда наберётся нужное число подтверждений\\.`;
  } else {
    meaning =
      `Это операция управления Safe\\-кошельком, но конкретный её тип бот не распознал\\. `
      + `Перед подписью проверьте детали транзакции вручную в интерфейсе Safe\\.`;
  }

  const extraBlocks: OperationTemplate['extraBlocks'] = [];
  if (params?.method) {
    const preview = await buildSafeStatePreviewBlock(tx, [{ method: String(params.method), params }]);
    if (preview) extraBlocks.push(preview);
  }

  return {
    blockTitle: '⚙️ *Управление Safe*',
    blockTree: tree,
    meaning,
    balanceOverride: ['Не изменится — изменяются только настройки кошелька'],
    skipProtocolLine: true,
    extraBlocks: extraBlocks.length > 0 ? extraBlocks : undefined,
  };
}

function cancelTemplate(): OperationTemplate {
  const meaning = `Эта транзакция отменяет предыдущую с тем же порядковым номером \\(nonce\\)\\. `
    + `Когда она исполнится, неподписанная транзакция в очереди станет невалидной\\.`;

  return {
    blockTitle: '🚫 *Отмена pending\\-транзакции*',
    blockTree: [],
    meaning,
    balanceOverride: ['Не изменится — отмена только освобождает номер в очереди'],
    skipProtocolLine: true,
  };
}

function multisendTemplate(tx: ProcessedTransaction): OperationTemplate {
  const calls = tx.multiSendInnerCalls || [];

  const meaning = `MultiSend склеивает несколько действий в одну транзакцию — они выполнятся все вместе или не выполнятся совсем \\(атомарно\\)\\. `
    + `Состав пакета — в блоке *Внутренние операции multiSend* выше\\.`;

  return {
    blockTitle: `📦 *Пакет действий \\(${calls.length}\\)*`,
    blockTree: [],
    meaning,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

async function safeAdminBatchTemplate(tx: ProcessedTransaction): Promise<OperationTemplate> {
  const calls = tx.multiSendInnerCalls || [];
  const shortAddr = (a: string) => `\`${a.slice(0, 6)}…${a.slice(-4)}\``;

  const rows: string[] = [];
  for (const c of calls) {
    const p = (c.params || {}) as Record<string, unknown>;
    const m = c.method || 'unknown';
    let row: string;
    switch (m) {
      case 'addOwnerWithThreshold':
        row = `Добавление владельца ${shortAddr(String(p.owner))} \\(новый порог ${Number(p.threshold)}\\)`;
        break;
      case 'removeOwner':
        row = `Удаление владельца ${shortAddr(String(p.owner))} \\(новый порог ${Number(p.threshold)}\\)`;
        break;
      case 'swapOwner':
        row = `Замена владельца ${shortAddr(String(p.oldOwner))} → ${shortAddr(String(p.newOwner))}`;
        break;
      case 'changeThreshold':
        row = `Новый порог подписей: ${Number(p.threshold)}`;
        break;
      case 'enableModule':
        row = `Включение модуля ${shortAddr(String(p.module))}`;
        break;
      case 'disableModule':
        row = `Отключение модуля ${shortAddr(String(p.module))}`;
        break;
      case 'setGuard': {
        const g = String(p.guard || '');
        row = /^0x0+$/.test(g)
          ? `Сброс guard \\(0x0\\)`
          : `Установка guard ${shortAddr(g)}`;
        break;
      }
      case 'approveHash':
        row = `Подтверждение хэша ${shortAddr(String(p.hash))}`;
        break;
      default:
        row = `${escapeMarkdown(m)}`;
    }
    rows.push(row);
  }

  const meaning =
    `Это пакетное изменение настроек самого кошелька — несколько операций управления Safe одной транзакцией\\. `
    + `Все они применятся атомарно: либо весь пакет вместе, либо никак\\. `
    + `Сочетание операций может быть опасным: например, *снижение порога \\+ добавление нового владельца* фактически даёт одному адресу полный контроль над кошельком\\. `
    + `Внимательно проверьте каждый пункт выше и адреса владельцев перед подписью\\.`;

  const ops: SafeAdminOp[] = calls.map(c => ({
    method: c.method || '',
    params: c.params,
  }));
  const preview = await buildSafeStatePreviewBlock(tx, ops);

  return {
    blockTitle: `⚙️ *Пакетная настройка Safe \\(${calls.length}\\)*`,
    blockTree: rows,
    meaning,
    balanceOverride: ['Не изменится — изменяются только настройки кошелька'],
    skipProtocolLine: true,
    extraBlocks: preview ? [preview] : undefined,
  };
}

function extractCowApproveInfo(tx: ProcessedTransaction): { humanAmount: string; symbol: string; isUnlimited: boolean } | null {
  const order = tx.cowOrders?.[0];
  if (!order) return null;
  const params = tx.decodedParams as { method?: string; tokenAddress?: string; isUnlimited?: boolean; amount?: bigint | string } | null;
  if (!params || params.method !== 'approve') return null;
  if (params.tokenAddress && params.tokenAddress.toLowerCase() !== order.sellTokenAddress.toLowerCase()) return null;
  return {
    humanAmount: order.sellAmount,
    symbol: order.sellSymbol,
    isUnlimited: !!params.isUnlimited,
  };
}

function formatCowDeadline(validToTimestamp: number): { absolute: string; relative: string } {
  const date = new Date(validToTimestamp * 1000);
  const absolute = date.toLocaleString('ru-RU', {
    timeZone: 'UTC',
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
  const remainingMs = validToTimestamp * 1000 - Date.now();
  let relative: string;
  if (remainingMs <= 0) {
    relative = 'истёк';
  } else {
    const min = Math.floor(remainingMs / 60_000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);
    if (day > 0) relative = `~${day} дн`;
    else if (hr > 0) relative = `~${hr} ч`;
    else relative = `${min} мин`;
  }
  return { absolute, relative };
}

function swapCowLimitTemplate(tx: ProcessedTransaction): OperationTemplate {
  const order = tx.cowOrders?.[0];
  const approve = extractCowApproveInfo(tx);

  let meaning: string;
  if (order && approve) {
    const amountText = approve.isUnlimited
      ? `безлимитный approve на ${escapeMarkdown(approve.symbol)}`
      : `approve на ${escapeMarkdown(approve.humanAmount)} ${escapeMarkdown(approve.symbol)}`;
    const deadline = formatCowDeadline(order.validToTimestamp);
    const deadlineText = `${escapeMarkdown(deadline.absolute)} UTC`;
    meaning = `Лимитный ордер ждёт, пока солвер CoW Protocol сведёт его по цене не хуже указанной\\. `
      + `В этой же транзакции вы выдаёте ${amountText} в адрес CoW Vault — он сработает *только* в момент сведения; `
      + `пока ордер не исполнен, токены остаются на кошельке\\. `
      + `Если до ${deadlineText} встречной стороны не нашлось — ордер истечёт, токены и approve останутся\\.`;
  } else {
    meaning = `Лимитный ордер ждёт, пока солвер CoW Protocol предложит цену не хуже указанной\\. `
      + `Сейчас вы только подписываете намерение — токены не списываются и не блокируются\\. `
      + `Они остаются на кошельке до фактического исполнения ордера\\.`;
  }

  return {
    blockTitle: null,
    blockTree: [],
    meaning,
    balanceOverride: ['Изменится только в момент исполнения ордера солвером'],
    skipProtocolLine: true,
  };
}

function cancelCowOrderTemplate(tx: ProcessedTransaction): OperationTemplate {
  const cancels = tx.cowOrders?.filter(o => o.cancelled) || [];
  const knownCancels = cancels.filter(o => o.sellSymbol !== '?' && o.buySymbol !== '?');
  const hasUnresolved = cancels.length > knownCancels.length;

  let meaning =
    `\`invalidateOrder\` снимает с CoW Protocol ранее размещённый ордер: подписанное намерение становится недействительным, и солверы больше не смогут его исполнить\\. `
    + `Токены, которые "висели" под ордером, не двигаются — они и так оставались на кошельке\\. `
    + `Approve sellToken на CoW Vault эта операция НЕ отзывает\\.`;
  if (hasUnresolved) {
    meaning += ` Детали отменяемого ордера не удалось получить из CoW Orderbook \\(возможно, ордер слишком старый или сеть не поддерживается\\) — проверьте orderUid вручную\\.`;
  }

  return {
    blockTitle: null,
    blockTree: [],
    meaning,
    balanceOverride: ['Не изменится — отменяется только намерение; токены и approve остаются на кошельке'],
    skipProtocolLine: true,
  };
}

function swapCowMarketTemplate(tx: ProcessedTransaction): OperationTemplate {
  const order = tx.cowOrders?.[0];
  const approve = extractCowApproveInfo(tx);

  let meaning: string;
  if (order && approve) {
    const amountText = approve.isUnlimited
      ? `безлимитный approve на ${escapeMarkdown(approve.symbol)}`
      : `approve на ${escapeMarkdown(approve.humanAmount)} ${escapeMarkdown(approve.symbol)}`;
    const minText = order.kind === 'sell'
      ? `${escapeMarkdown(order.buyAmount)} ${escapeMarkdown(order.buySymbol)} — это *минимум* к получению \\(с учётом проскальзывания\\), фактически может прийти больше\\. `
      : `${escapeMarkdown(order.sellAmount)} ${escapeMarkdown(order.sellSymbol)} — это *максимум* к отдаче, фактически может списаться меньше\\. `;
    const deadline = formatCowDeadline(order.validToTimestamp);
    meaning = `Рыночный ордер CoW: солверы конкурируют за исполнение и обычно сводят сделку за секунды\\-минуты\\. `
      + minText
      + `Газ за неудачное исполнение не списывается — его платит солвер\\. `
      + `Approve в этой же транзакции \\(${amountText} для CoW Vault\\) сработает *только* в момент сведения; `
      + `пока ордер не исполнен, токены остаются на кошельке\\. `
      + `Если до ${escapeMarkdown(deadline.absolute)} UTC сделка не сложится — ордер истечёт без списания\\.`;
  } else {
    meaning = `Рыночный обмен через CoW Protocol: солверы конкурируют за лучшее исполнение и обычно сводят сделку за секунды\\-минуты\\. `
      + `Указанная сумма получения — минимум с учётом проскальзывания, фактически может прийти больше\\. `
      + `Газ за неудачное исполнение не списывается — его платит солвер\\.`;
  }

  return {
    blockTitle: null,
    blockTree: [],
    meaning,
    balanceOverride: ['Применится в момент сведения солвером \\(обычно секунды\\-минуты\\)'],
    skipProtocolLine: true,
  };
}

function unknownTemplate(): OperationTemplate {
  return {
    blockTitle: null,
    blockTree: [],
    meaning: null,
    balanceOverride: null,
    skipProtocolLine: false,
  };
}

export async function buildTemplate(
  tx: ProcessedTransaction,
  kind: OperationKind,
  ctx: OperationContext,
): Promise<OperationTemplate> {
  switch (kind) {
    case 'approve':          return await approveTemplate(tx);
    case 'swap':             return swapTemplate(tx, ctx);
    case 'swap-cow':         return swapCowMarketTemplate(tx);
    case 'swap-cow-limit':   return swapCowLimitTemplate(tx);
    case 'cancel-cow-order': return cancelCowOrderTemplate(tx);
    case 'bridge':           return bridgeTemplate(tx, ctx);
    case 'deposit':          return depositTemplate(tx, ctx);
    case 'deposit-lending':  return depositLendingTemplate(tx, ctx);
    case 'deposit-staking':  return depositStakingTemplate(tx, ctx);
    case 'withdraw':         return withdrawTemplate(tx, ctx);
    case 'borrow':           return borrowTemplate(tx, ctx);
    case 'repay':            return repayTemplate(tx, ctx);
    case 'claim':            return claimTemplate(tx, ctx);
    case 'transfer-native':  return await transferNativeTemplate(tx, ctx);
    case 'transfer-erc20':   return await transferErc20Template(tx, ctx);
    case 'wrap':             return wrapTemplate(tx, ctx);
    case 'unwrap':           return unwrapTemplate(tx, ctx);
    case 'safe-admin':       return await safeAdminTemplate(tx);
    case 'safe-admin-batch': return await safeAdminBatchTemplate(tx);
    case 'cancel':           return cancelTemplate();
    case 'multisend':        return multisendTemplate(tx);
    case 'unknown':
    default:                 return unknownTemplate();
  }
}

export { fmtSignedAmount };
