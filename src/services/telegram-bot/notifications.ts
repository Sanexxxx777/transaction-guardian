import { prisma } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { escapeMarkdown, formatNumber } from '../../utils/formatters.js';
import { getBot } from './index.js';
import { getPriceFetcher, TOKEN_COINGECKO_IDS } from '../price-fetcher/index.js';
import { detectOperationKind, buildOperationContext, buildTemplate } from '../notification-templates/index.js';
import type { ProcessedTransaction, RiskLevel, AssetChange } from '../../models/transaction.js';
import type { PolicyViolation } from '../../models/policy.js';
import type { AIAnalysisResult } from '../ai-analyzer/index.js';

const logger = createLogger('notifications');

const RETRY_DELAYS = [1000, 3000, 9000];
const MAX_MESSAGE_LENGTH = 4096;

const STABLECOINS = new Set(['USDC', 'USDT', 'DAI', 'FRAX', 'LUSD']);

const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum', 10: 'Optimism', 56: 'BNB Chain', 137: 'Polygon',
  8453: 'Base', 42161: 'Arbitrum', 43114: 'Avalanche', 59144: 'Linea',
  5000: 'Mantle', 324: 'zkSync',
};

function codeSpanAddr(addr: string): string {
  return addr.replace(/`/g, '');
}

function shortenCowUid(uid: string): string {
  if (!uid || uid.length < 20) return uid;
  return `${uid.slice(0, 10)}…${uid.slice(-6)}`;
}

const COW_EXPLORER_CHAIN_PREFIX: Record<number, string> = {
  1: '',
  100: 'gc',
  42161: 'arb1',
  8453: 'base',
  137: 'polygon',
  11155111: 'sepolia',
};

function buildCowExplorerUrl(chainId: number, orderUid: string): string | null {
  const prefix = COW_EXPLORER_CHAIN_PREFIX[chainId];
  if (prefix === undefined) return null;
  return prefix
    ? `https://explorer.cow.fi/${prefix}/orders/${orderUid}`
    : `https://explorer.cow.fi/orders/${orderUid}`;
}

const SIMULATION_ERROR_TRANSLATIONS: Array<[RegExp, string]> = [
  [/insufficient balance for transfer/i, 'недостаточный баланс для перевода'],
  [/insufficient funds/i, 'недостаточно средств'],
  [/execution reverted/i, 'транзакция отменена контрактом'],
  [/out of gas/i, 'недостаточно газа'],
  [/transfer amount exceeds balance/i, 'сумма превышает баланс'],
  [/ERC20: transfer amount exceeds allowance/i, 'сумма превышает разрешение (allowance)'],
  [/STF$/i, 'ошибка перевода токенов'],
];

function translateSimulationError(error: string): string {
  for (const [pattern, translation] of SIMULATION_ERROR_TRANSLATIONS) {
    if (pattern.test(error)) return translation;
  }
  return error.length > 80 ? error.slice(0, 80) + '...' : error;
}

async function lookupProtocolName(address: string, chainId: number): Promise<string | null> {
  try {
    const protocols = await prisma.protocolWhitelist.findMany({
      where: { isActive: true },
      select: { protocolName: true, contractAddresses: true },
    });
    const addrLower = address.toLowerCase();
    for (const p of protocols) {
      const addrMap = p.contractAddresses as Record<string, string[]>;
      const chainAddrs = addrMap[chainId.toString()] || [];
      if (chainAddrs.some((a: string) => a.toLowerCase() === addrLower)) {
        return p.protocolName;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function sendWithRetry(
  bot: ReturnType<typeof getBot>,
  chatId: number,
  message: string,
  options: Record<string, unknown>
): Promise<void> {
  let lastError: unknown;

  if (message.length > MAX_MESSAGE_LENGTH) {
    const cutTarget = MAX_MESSAGE_LENGTH - 40;
    const lastNl = message.lastIndexOf('\n', cutTarget);
    const cutAt = lastNl > cutTarget * 0.5 ? lastNl : cutTarget;
    message = message.slice(0, cutAt) + '\n\n_\\.\\.\\. сообщение обрезано_';
  }

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      await bot!.api.sendMessage(chatId, message, options);
      return;
    } catch (error) {
      lastError = error;
      if (error && typeof error === 'object' && 'error_code' in error) {
        const code = (error as { error_code: number }).error_code;
        if (code === 403 || code === 400 || code === 404) {
          logger.error({ code, chatId }, 'Permanent Telegram error, not retrying');
          throw error;
        }
      }
      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        logger.warn({ attempt: attempt + 1, delayMs: delay }, 'Telegram API failed, retrying...');
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  throw lastError;
}

export async function sendTransactionNotification(
  clientId: string,
  transaction: ProcessedTransaction,
  violations: PolicyViolation[],
  riskLevel: RiskLevel,
  aiAnalysis?: AIAnalysisResult | null,

  targetChatId?: bigint | number,
): Promise<boolean> {
  const bot = getBot();
  if (!bot) {
    logger.error('Bot not initialized');
    return false;
  }

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { telegramChatId: true, name: true },
  });

  if (!client) {
    logger.error({ clientId }, 'Client not found');
    return false;
  }

  const wallet = await prisma.wallet.findFirst({
    where: {
      address: { equals: transaction.walletAddress, mode: 'insensitive' },
      chainId: transaction.chainId,
    },
    select: { name: true, type: true },
  });

  const network = await prisma.network.findUnique({
    where: { chainId: transaction.chainId },
    select: { name: true, shortName: true, explorerUrl: true },
  });

  const walletType = wallet?.type || transaction.walletType || 'safe';
  const message = await buildTransactionMessage(
    transaction, violations, riskLevel,
    wallet?.name || null,
    walletType as 'safe' | 'eoa',
    network?.name || 'Unknown',
    network?.shortName || 'eth',
    network?.explorerUrl || '',
    aiAnalysis
  );

  const destChatId = targetChatId !== undefined ? Number(targetChatId) : Number(client.telegramChatId);
  const isOverride = targetChatId !== undefined;

  try {
    await sendWithRetry(bot, destChatId, message, {
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });

    const txId = transaction.safeTxHash || transaction.txHash;

    if (!isOverride) {
      if (transaction.safeTxHash) {
        await prisma.transactionHistory.update({
          where: { safeTxHash_chainId: { safeTxHash: transaction.safeTxHash, chainId: transaction.chainId } },
          data: { pendingNotificationSentAt: new Date() },
        });
      } else if (transaction.txHash) {
        await prisma.transactionHistory.update({
          where: { txHash_chainId: { txHash: transaction.txHash, chainId: transaction.chainId } },
          data: { pendingNotificationSentAt: new Date() },
        });
      }
    }

    logger.info({ clientId, txId, riskLevel, override: isOverride, destChatId }, 'Transaction notification sent');
    return true;
  } catch (error) {
    logger.error({ error, clientId, destChatId }, 'Failed to send notification after retries');
    return false;
  }
}

export async function sendStatusNotification(
  safeTxHash: string,
  chainId: number,
  newStatus: string,
  explorerTxHash?: string
): Promise<boolean> {
  const bot = getBot();
  if (!bot) return false;

  const tx = await prisma.transactionHistory.findUnique({
    where: { safeTxHash_chainId: { safeTxHash, chainId } },
    include: { wallet: { include: { client: true } } },
  });

  if (!tx) {
    logger.error({ safeTxHash, chainId }, 'Transaction not found');
    return false;
  }

  const network = await prisma.network.findUnique({
    where: { chainId },
    select: { name: true, shortName: true, explorerUrl: true },
  });

  const message = buildStatusMessage(
    newStatus,
    tx.toAddress,
    tx.decodedMethod,
    network?.name || 'Unknown',
    network?.shortName || 'eth',
    network?.explorerUrl || '',
    tx.wallet.address,
    explorerTxHash || tx.txHash || undefined,
    tx.nonce ?? undefined
  );

  try {
    await sendWithRetry(bot, Number(tx.wallet.client.telegramChatId), message, {
      parse_mode: 'MarkdownV2',
      link_preview_options: { is_disabled: true },
    });

    await prisma.transactionHistory.update({
      where: { safeTxHash_chainId: { safeTxHash, chainId } },
      data: { statusNotificationSentAt: new Date() },
    });

    return true;
  } catch (error) {
    logger.error({ error, safeTxHash }, 'Failed to send status notification after retries');
    return false;
  }
}

async function buildTransactionMessage(
  tx: ProcessedTransaction,
  violations: PolicyViolation[],
  riskLevel: RiskLevel,
  walletName: string | null,
  walletType: 'safe' | 'eoa',
  networkName: string,
  networkShortName: string,
  explorerUrl: string,
  aiAnalysis?: AIAnalysisResult | null
): Promise<string> {
  const lines: string[] = [];

  let eoaDirection: 'in' | 'out' | null = null;
  if (walletType === 'eoa' && tx.walletAddress) {
    const addr = tx.walletAddress.toLowerCase();
    const isOutgoing = tx.from?.toLowerCase() === addr;
    const isIncoming = tx.to?.toLowerCase() === addr;
    if (isOutgoing && !isIncoming) eoaDirection = 'out';
    else if (isIncoming && !isOutgoing) eoaDirection = 'in';
  }

  const isNativeTransfer = (!tx.data || tx.data === '0x' || tx.data === '0x00') && tx.value && BigInt(tx.value) > 0n;

  const protocolFromDb = await lookupProtocolName(tx.to, tx.chainId);
  const resolvedProtocol = tx.detectedProtocol || protocolFromDb;
  const opKind = detectOperationKind(tx, resolvedProtocol);
  const opCtx = await buildOperationContext(tx, resolvedProtocol);
  const template = await buildTemplate(tx, opKind, opCtx);

  const skipEducational = walletType === 'eoa' && tx.status === 'executed';

  const nonceTag = tx.nonce !== undefined && tx.nonce !== null ? ` \\#${tx.nonce}` : '';
  if (riskLevel === 'danger') {
    lines.push(`🚨 *ВНИМАНИЕ: Обнаружены риски${nonceTag}*`);
  } else if (riskLevel === 'warning') {
    lines.push(`⚠️ *Транзакция${nonceTag} требует внимания*`);
  } else {
    if (eoaDirection) {
      lines.push(`✅ *${eoaDirection === 'in' ? 'Входящая' : 'Исходящая'} транзакция${nonceTag}*`);
    } else {
      lines.push(`✅ *Новая транзакция${nonceTag}*`);
    }
  }
  lines.push('');

  lines.push(`Кошелёк: \`${codeSpanAddr(tx.walletAddress)}\` \\(${escapeMarkdown(networkName)}\\)`);

  const isSelfRecipient = tx.to.toLowerCase() === tx.walletAddress.toLowerCase();
  const selfNote = isSelfRecipient ? ' \\(совпадает с кошельком\\)' : '';
  const protocolName = resolvedProtocol;

  if (!template.skipProtocolLine) {
    if (protocolName) {
      const checkmark = protocolFromDb ? ' ✅' : '';
      lines.push(`Протокол: ${escapeMarkdown(protocolName)}${checkmark}${selfNote}`);
    } else {
      lines.push(`Контракт: \`${codeSpanAddr(tx.to)}\`${selfNote}`);
    }

    if (tx.detectedRecipient && tx.detectedRecipient.toLowerCase() !== tx.to.toLowerCase()) {
      const recipIsSelf = tx.detectedRecipient.toLowerCase() === tx.walletAddress.toLowerCase();
      const recipLabel = await lookupProtocolName(tx.detectedRecipient, tx.chainId);
      const recipNote = recipIsSelf ? ' \\(совпадает с кошельком\\)' : (recipLabel ? ` \\(${escapeMarkdown(recipLabel)}\\)` : '');
      lines.push(`Получатель: \`${codeSpanAddr(tx.detectedRecipient)}\`${recipNote}`);
    }
  }

  lines.push('');

  if (aiAnalysis) {
    lines.push(`*${escapeMarkdown(aiAnalysis.headline)}*`);
    for (const detail of aiAnalysis.details) {
      lines.push(`└── ${escapeMarkdown(detail)}`);
    }
    lines.push('');
  } else if (tx.decodedMethod) {
    lines.push(`*${escapeMarkdown(tx.decodedMethod)}*`);
    lines.push('');
  }

  if (template.blockTitle) {
    lines.push(template.blockTitle);
    for (let i = 0; i < template.blockTree.length; i++) {
      const conn = i === template.blockTree.length - 1 ? '└──' : '├──';
      lines.push(`${conn} ${template.blockTree[i]}`);
    }
    lines.push('');
  }

  if (template.extraBlocks) {
    for (const blk of template.extraBlocks) {
      lines.push(blk.title);
      for (let i = 0; i < blk.rows.length; i++) {
        const conn = i === blk.rows.length - 1 ? '└──' : '├──';
        lines.push(`${conn} ${blk.rows[i]}`);
      }
      lines.push('');
    }
  }

  if (template.balanceOverride && template.balanceOverride.length > 0) {
    lines.push('*Изменение баланса:*');
    for (let i = 0; i < template.balanceOverride.length; i++) {
      const conn = i === template.balanceOverride.length - 1 ? '└──' : '├──';
      lines.push(`${conn} ${template.balanceOverride[i]}`);
    }
    lines.push('');
  } else if (tx.simulationResult?.assetChanges && tx.simulationResult.assetChanges.length > 0) {
    const safeAddrLower = tx.walletAddress.toLowerCase();
    const netChanges = new Map<string, { symbol: string; decimals: number; netRaw: bigint }>();

    for (const change of tx.simulationResult.assetChanges) {
      const symbol = (change.tokenSymbol || 'TOKEN').toUpperCase();
      const decimals = change.tokenDecimals || 18;
      if (!netChanges.has(symbol)) {
        netChanges.set(symbol, { symbol, decimals, netRaw: BigInt(0) });
      }
      const entry = netChanges.get(symbol)!;
      const rawAmount = /^\d+$/.test(change.amount || '0') ? BigInt(change.amount || '0') : BigInt(0);
      const isOutgoing = change.from && change.from.toLowerCase() === safeAddrLower;
      const isIncoming = change.to && change.to.toLowerCase() === safeAddrLower;
      if (isOutgoing && !isIncoming) entry.netRaw -= rawAmount;
      else if (isIncoming && !isOutgoing) entry.netRaw += rawAmount;
    }

    const significantChanges = Array.from(netChanges.values()).filter(c => c.netRaw !== BigInt(0));

    if (significantChanges.length > 0) {
      const usdPrices: Record<string, number | null> = {};
      const priceFetcher = getPriceFetcher();

      for (const change of significantChanges) {
        if (STABLECOINS.has(change.symbol)) {
          usdPrices[change.symbol] = 1.0;
        } else if (TOKEN_COINGECKO_IDS[change.symbol]) {
          try {
            usdPrices[change.symbol] = await priceFetcher.getPrice(change.symbol);
          } catch {
            usdPrices[change.symbol] = null;
          }
        }
      }

      lines.push('*Изменение баланса:*');

      for (let i = 0; i < significantChanges.length; i++) {
        const change = significantChanges[i];
        const isPositive = change.netRaw > BigInt(0);
        const absRaw = isPositive ? change.netRaw : -change.netRaw;

        const divisor = BigInt(10 ** change.decimals);
        const whole = absRaw / divisor;
        const fraction = absRaw % divisor;
        const fractionStr = fraction.toString().padStart(change.decimals, '0').slice(0, 6);
        const displayAmount = `${whole}.${fractionStr}`.replace(/\.?0+$/, '') || '0';

        const sign = isPositive ? '\\+' : '\\-';
        const connector = i === significantChanges.length - 1 ? '└──' : '├──';

        let usdStr = '';
        const price = usdPrices[change.symbol];
        if (price !== null && price !== undefined) {
          const numAmount = Number(whole) + Number(fraction) / (10 ** change.decimals);
          const usdAmount = numAmount * price;
          usdStr = ` \\(${sign}$${escapeMarkdown(formatNumber(usdAmount, 3))}\\)`;
        }

        lines.push(`${connector} ${escapeMarkdown(change.symbol)}: ${sign}${escapeMarkdown(displayAmount)}${usdStr}`);
      }
      lines.push('');
    }
  }

  if (tx.destinationChainId) {
    const srcChain = CHAIN_NAMES[tx.chainId] || `Chain ${tx.chainId}`;
    const dstChain = CHAIN_NAMES[tx.destinationChainId] || `Chain ${tx.destinationChainId}`;
    lines.push(`🌉 *Бридж:* ${escapeMarkdown(srcChain)} → ${escapeMarkdown(dstChain)}`);
    lines.push('');
  }

  const isCanonicalCowMultiSend = !!(tx.cowOrders && tx.cowOrders.length > 0
    && tx.multiSendInnerCalls && tx.multiSendInnerCalls.length > 0
    && tx.multiSendInnerCalls.every(c => {
      if (c.method === 'approve') return true;
      if (c.protocol === 'CoW Protocol' && c.method && ['setPreSignature', 'invalidateOrder'].includes(c.method)) return true;
      return false;
    }));

  const isSafeAdminBatch = !!(tx.multiSendInnerCalls && tx.multiSendInnerCalls.length > 0
    && tx.multiSendInnerCalls.every(c =>
      c.protocol === 'Safe' && c.to.toLowerCase() === tx.walletAddress.toLowerCase()
    ));

  if (tx.multiSendInnerCalls && tx.multiSendInnerCalls.length > 1 && !isCanonicalCowMultiSend && !isSafeAdminBatch) {
    lines.push('*Внутренние операции multiSend:*');
    for (let i = 0; i < tx.multiSendInnerCalls.length; i++) {
      const c = tx.multiSendInnerCalls[i];
      const conn = i === tx.multiSendInnerCalls.length - 1 ? '└──' : '├──';
      const protoStr = c.protocol ? `${escapeMarkdown(c.protocol)}: ` : '';
      const methodStr = escapeMarkdown(c.method || 'unknown');
      lines.push(`${conn} ${protoStr}${methodStr} → \`${codeSpanAddr(c.to)}\``);
    }
    lines.push('');
  }

  if (tx.cowOrders && tx.cowOrders.length > 0) {
    const approveParams = tx.decodedParams as { method?: string; tokenAddress?: string; isUnlimited?: boolean; amount?: bigint | string } | null;
    const hasBundledApprove = approveParams?.method === 'approve';

    for (const order of tx.cowOrders) {
      const isLimit = order.class === 'limit';
      const isCancel = !!order.cancelled;
      const isUnresolved = isCancel && (order.sellSymbol === '?' || order.buySymbol === '?');
      const typeLabel = isLimit ? '📋 Лимитный' : '🔄 Рыночный';
      const kindLabel = order.kind === 'sell' ? 'sell-order' : 'buy-order';

      if (isUnresolved) {
        lines.push(`*🚫 Отмена ордера CoW:*`);
        const shortUid = shortenCowUid(order.uid);
        const explorerUrl = buildCowExplorerUrl(tx.chainId, order.uid);
        lines.push(`├── orderUid: \`${shortUid}\``);
        lines.push(`├── _Детали ордера не найдены в CoW Orderbook_`);
        if (explorerUrl) {
          lines.push(`└── [Открыть ордер в CoW Explorer](${explorerUrl})`);
        } else {
          lines.push(`└── _Эксплорер для этой сети недоступен_`);
        }
        lines.push('');
        continue;
      }

      const validToDate = new Date(order.validToTimestamp * 1000);
      const validToHuman = validToDate.toLocaleString('ru-RU', {
        timeZone: 'UTC',
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      });
      const remainingMs = order.validToTimestamp * 1000 - Date.now();
      let remainingStr: string;
      if (remainingMs <= 0) {
        remainingStr = 'истёк';
      } else {
        const min = Math.floor(remainingMs / 60_000);
        const hr = Math.floor(min / 60);
        const day = Math.floor(hr / 24);
        if (day > 0) remainingStr = `~${day} дн`;
        else if (hr > 0) remainingStr = `~${hr} ч`;
        else remainingStr = `${min} мин`;
      }

      const detailLines: string[] = [];
      const sellSym = escapeMarkdown(order.sellSymbol);
      const buySym = escapeMarkdown(order.buySymbol);

      if (isCancel) {
        const sellAmt = escapeMarkdown(order.sellAmount);
        const buyAmt = escapeMarkdown(order.buyAmount);
        const arrow = order.kind === 'sell' ? '→ ≥' : '≤';
        detailLines.push(`Что отменяется: ${sellAmt} ${sellSym} ${arrow} ${buyAmt} ${buySym}`);
        detailLines.push(`Тип отменяемого: ${typeLabel} \\(${escapeMarkdown(kindLabel)}\\)`);
      } else {
        detailLines.push(`Тип: ${typeLabel} \\(${escapeMarkdown(kindLabel)}\\)`);
      }

      const STATUS_BADGES: Record<string, string> = {
        fulfilled: '✅ исполнен',
        cancelled: '🚫 отменён',
        expired: '⏰ истёк срок',
        presignaturePending: 'ожидает подписи',
      };
      if (order.status && STATUS_BADGES[order.status]) {
        const label = isCancel ? 'Статус сейчас' : 'Статус';
        detailLines.push(`${label}: ${escapeMarkdown(STATUS_BADGES[order.status])}`);
      }

      const sellNum = parseFloat(order.sellAmount);
      const buyNum = parseFloat(order.buyAmount);
      const fmtRatio = (n: number): string => {
        if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
        if (n >= 1) return n.toFixed(6).replace(/\.?0+$/, '');
        if (n >= 0.0001) return n.toFixed(8).replace(/\.?0+$/, '');
        return n.toExponential(3);
      };

      if (isLimit) {
        if (sellNum > 0 && buyNum > 0) {
          const fwd = buyNum / sellNum;
          const inv = sellNum / buyNum;
          const label = isCancel ? 'Цена ордера' : 'Цена';
          detailLines.push(`${label}: 1 ${sellSym} \\= ${escapeMarkdown(fmtRatio(fwd))} ${buySym}`);
          detailLines.push(`${label}: 1 ${buySym} \\= ${escapeMarkdown(fmtRatio(inv))} ${sellSym}`);
        }
      } else if (!isCancel) {
        if (order.kind === 'sell') {
          detailLines.push(`Минимум к получению: ${escapeMarkdown(order.buyAmount)} ${buySym}`);
        } else {
          detailLines.push(`Максимум к отдаче: ${escapeMarkdown(order.sellAmount)} ${sellSym}`);
        }
        if (sellNum > 0 && buyNum > 0) {
          const fwd = buyNum / sellNum;
          detailLines.push(`Курс: 1 ${sellSym} ≈ ${escapeMarkdown(fmtRatio(fwd))} ${buySym}`);
        }
      }

      const deadlineLabel = isCancel ? 'Действителен был до' : 'Срок: до';
      detailLines.push(`${deadlineLabel}: ${escapeMarkdown(validToHuman)} UTC \\(${escapeMarkdown(remainingStr)}\\)`);
      if (!order.receiverIsSelf) {
        detailLines.push(`Получатель: \`${codeSpanAddr(order.receiver)}\` ⚠️ не совпадает с кошельком`);
      }
      if (order.partiallyFillable && !isCancel) {
        detailLines.push(`Частичное исполнение разрешено`);
      }

      if (isCancel) {
        const shortUid = shortenCowUid(order.uid);
        detailLines.push(`orderUid: \`${shortUid}\``);
        const explorerUrl = buildCowExplorerUrl(tx.chainId, order.uid);
        if (explorerUrl) {
          detailLines.push(`[Открыть ордер в CoW Explorer](${explorerUrl})`);
        }
      }

      if (!isCancel && hasBundledApprove && order === tx.cowOrders[0]) {
        const approveAmount = approveParams?.isUnlimited
          ? `безлимитный ${sellSym}`
          : `${escapeMarkdown(order.sellAmount)} ${sellSym}`;
        detailLines.push(`🔓 Approve в пакете: ${approveAmount} → CoW Vault`);
      }

      const blockHeader = isCancel
        ? `*🚫 Отмена ордера CoW \\(${escapeMarkdown(kindLabel)}\\):*`
        : `*${typeLabel} ордер CoW:*`;
      lines.push(blockHeader);
      for (let i = 0; i < detailLines.length; i++) {
        const conn = i === detailLines.length - 1 ? '└──' : '├──';
        lines.push(`${conn} ${detailLines[i]}`);
      }
      lines.push('');
    }
  }

  const isCowProtocol = tx.detectedProtocol === 'CoW Protocol'
    || (tx.decodedMethod || '').toLowerCase().includes('setpresignature')
    || (tx.decodedMethod || '').toLowerCase().includes('cow');

  if (tx.simulationSuccess === false && !isCowProtocol) {
    let errorStr = '';
    if (tx.simulationResult?.error) {
      const translated = translateSimulationError(tx.simulationResult.error);
      errorStr = ` — ${escapeMarkdown(translated)}`;
    }
    lines.push(`⚠️ _Симуляция: транзакция не пройдёт${errorStr}_`);
    lines.push('');
  }

  if (isCowProtocol && (!tx.cowOrders || tx.cowOrders.length === 0)) {
    lines.push('_Итоговая сумма обмена определяется солверами CoW_');
    lines.push('');
  }

  if (!skipEducational && template.meaning) {
    lines.push('ℹ️ *Что это значит*');
    lines.push(template.meaning);
    lines.push('');
  }

  if (violations.length > 0) {
    const dangerViolations = violations.filter(v => v.severity === 'danger');
    const warningViolations = violations.filter(v => v.severity === 'warning');
    const infoViolations = violations.filter(v => v.severity === 'info');

    if (dangerViolations.length > 0 || warningViolations.length > 0) {
      if (riskLevel === 'danger') {
        lines.push('🚨 *Обнаружены риски:*');
      } else {
        lines.push('⚠️ *Предупреждения:*');
      }

      for (const v of dangerViolations) {
        lines.push(`• *${escapeMarkdown(v.title)}*`);
        lines.push(`   ${escapeMarkdown(v.description)}`);
      }

      for (const v of warningViolations) {
        lines.push(`• *${escapeMarkdown(v.title)}*`);
        lines.push(`   ${escapeMarkdown(v.description)}`);
      }
      lines.push('');
    }

    if (infoViolations.length > 0) {
      for (const v of infoViolations) {
        lines.push(`${escapeMarkdown(v.title)}: ${escapeMarkdown(v.description)}`);
      }
      lines.push('');
    }
  } else {
    lines.push('✅ *Проверки пройдены*');
    lines.push('');
  }

  if (riskLevel === 'danger') {
    lines.push('🚨 *Не подписывайте*');
    lines.push('*Дождитесь рекомендации к действиям в чате*');
    lines.push('');
  } else if (riskLevel === 'warning') {
    lines.push('⚠️ *Прежде чем подписать — проверьте каждый пункт выше\\.*');
    lines.push('');
  }

  const links: string[] = [];
  if (walletType === 'safe') {
    links.push(`[Открыть в Safe](https://app.safe.global/transactions/queue?safe=${networkShortName}:${tx.walletAddress})`);
  }
  if (explorerUrl) {
    if (tx.txHash) {
      links.push(`[Explorer](${explorerUrl}/tx/${tx.txHash})`);
    } else if (tx.to) {
      links.push(`[Explorer](${explorerUrl}/address/${tx.to})`);
    }
  }
  if (links.length > 0) {
    lines.push(links.join(' \\| '));
  }
  lines.push('');

  if (walletType === 'eoa') {
    if (tx.gasUsed && tx.gasPrice) {
      const gasCostEth = (Number(tx.gasUsed) * Number(tx.gasPrice)) / 1e18;
      lines.push(`_Gas: ${escapeMarkdown(gasCostEth.toFixed(6))} ETH_`);
    }
    lines.push('_Транзакция обнаружена_');
  } else {
    lines.push('_Ожидает вашу подпись_');
  }

  return lines.join('\n');
}

function buildStatusMessage(
  status: string,
  toAddress: string,
  method: string | null,
  networkName: string,
  networkShortName: string,
  explorerUrl: string,
  walletAddress: string,
  txHash?: string,
  nonce?: number
): string {
  const lines: string[] = [];
  const nonceStr = nonce !== undefined ? ` \\#${nonce}` : '';

  switch (status) {
    case 'signed':
      lines.push(`*Транзакция${nonceStr} подписана*`);
      lines.push('');
      lines.push('_Ожидает исполнения_');
      if (explorerUrl && walletAddress) {
        lines.push('');
        lines.push(`[Открыть в Safe](https://app.safe.global/transactions/queue?safe=${networkShortName}:${walletAddress})`);
      }
      break;

    case 'executed':
      lines.push(`✅ *Транзакция${nonceStr} исполнена*`);
      lines.push('');
      if (txHash && explorerUrl) {
        lines.push(`[Посмотреть в Explorer](${explorerUrl}/tx/${txHash})`);
      }
      break;

    case 'failed':
      lines.push(`*Транзакция${nonceStr} не выполнена*`);
      lines.push('');
      lines.push('Транзакция была отправлена, но завершилась с ошибкой');
      if (txHash && explorerUrl) {
        lines.push(`[Посмотреть в Explorer](${explorerUrl}/tx/${txHash})`);
      }
      break;

    case 'rejected':
      lines.push(`🚫 *Транзакция${nonceStr} отменена*`);
      break;

    default:
      lines.push(`*Статус транзакции${nonceStr}: ${escapeMarkdown(status)}*`);
  }

  return lines.join('\n');
}
