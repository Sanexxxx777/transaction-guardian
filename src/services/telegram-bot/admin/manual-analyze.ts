import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { redis, isRedisAvailable, checkRateLimit } from '../../../db/redis.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { tg, code } from '../../../utils/tg-md.js';
import { createLogger } from '../../../utils/logger.js';
import { extractSafeUrls } from '../../manual-analyze/url-parser.js';
import { analyzeBySafeUrl, type AnalyzeResult, type AnalyzeStage } from '../../manual-analyze/index.js';
import { setManualToken } from '../../token-resolver/index.js';

const logger = createLogger('manual-analyze-tg');

const RATE_LIMIT_PER_MIN = 10;
const PENDING_URL_TTL_SEC = 600;
const PENDING_TOKEN_TTL_SEC = 300;

const STAGE_LABELS: Record<AnalyzeStage, string> = {
  parsing: '🔗 Парсинг URL...',
  wallet_lookup: '🔍 Поиск кошелька в БД...',
  safe_api: '☁️ Запрос Safe API...',
  simulation: '🧪 Симуляция Tenderly...',
  policy: '📋 Проверка политик...',
  ai: '🤖 AI-анализ (Gemini)...',
  sending: '📤 Отправка в чат клиента...',
  done: '✅ Готово',
};

const RISK_EMOJI: Record<string, string> = {
  ok: '✅',
  info: 'ℹ️',
  warning: '⚠️',
  danger: '🚨',
};

interface ProgressMessage {
  chatId: number;
  messageId: number;
}

async function updateProgress(
  bot: Bot<BotContext>,
  msg: ProgressMessage,
  stage: AnalyzeStage,
  history: AnalyzeStage[]
): Promise<void> {
  const lines = history.map(s => (s === stage ? `▸ ${STAGE_LABELS[s]}` : `· ${STAGE_LABELS[s]}`));
  const text = '⏳ *Ручной анализ транзакции*\n\n' + lines.map(l => escapeMarkdown(l)).join('\n');
  try {
    await bot.api.editMessageText(msg.chatId, msg.messageId, text, {
      parse_mode: 'MarkdownV2',
    });
  } catch (error) {
    logger.debug({ error }, 'Failed to update progress message (likely no-op edit)');
  }
}

function formatResultMessage(result: AnalyzeResult): { text: string; keyboard?: InlineKeyboard } {
  switch (result.status) {
    case 'ok': {
      const emoji = RISK_EMOJI[result.riskLevel] || '✅';
      const walletDisplay = result.walletName || 'кошелёк';
      const lines = [
        tg`${emoji} *Анализ завершён*`,
        '',
        tg`Клиент: ${result.clientName}`,
        tg`Кошелёк: ${walletDisplay}`,
        tg`Риск: ${result.riskLevel} \(${result.violationCount} violations\)`,
        result.aiHeadline ? tg`\n_${result.aiHeadline}_` : '',
        '',
        tg`📤 Отправлено в чат ${code(result.clientChatId)}`,
      ].filter(Boolean);
      return { text: lines.join('\n') };
    }
    case 'invalid_url':
      return { text: tg`❌ ${result.error}` };

    case 'wallet_not_found': {
      const kb = new InlineKeyboard().text(
        '➕ Добавить во все сети',
        `aw:dl:${result.address.toLowerCase()}`,
      );
      return {
        text:
          tg`❌ Кошелёк ${code(result.address)} не зарегистрирован\n` +
          tg`\(сеть chainId\=${result.chainId}\)\n\n` +
          tg`Запустить сканирование сетей и добавить?`,
        keyboard: kb,
      };
    }

    case 'tx_not_found':
      return {
        text:
          tg`❌ Транзакция не найдена в Safe TX Service\n` +
          tg`${code(result.safeTxHash.slice(0, 18))}\.\.\.\n\n` +
          tg`Возможно, она ещё не индексирована или ссылка устарела\.`,
      };

    case 'rate_limited': {
      const resetMin = Math.ceil(result.info.resetSeconds / 60);
      const kind = result.info.isMonthlyQuota ? 'месячная квота Safe API исчерпана' : 'temporary rate limit';
      return {
        text:
          tg`🚫 ${kind}\n\n` +
          tg`Reset через ~${resetMin} мин\n` +
          tg`Limit: ${result.info.limit}, Remaining: ${result.info.remaining}`,
      };
    }

    case 'already_analyzed': {
      const kb = new InlineKeyboard().text('🔁 Повторить анализ', `manual:repeat:${result.safeTxHash.slice(2, 18)}`);
      return {
        text:
          tg`⚠️ Эта транзакция уже анализировалась\n` +
          tg`Текущий статус: ${code(result.existingStatus)}` +
          (result.existingRiskLevel ? tg`, риск: ${code(result.existingRiskLevel)}` : '') +
          tg`\n\nПовторить и переотправить в чат?`,
        keyboard: kb,
      };
    }

    case 'notification_failed':
      return {
        text:
          tg`⚠️ *Анализ выполнен, но отправка в чат провалилась*\n\n` +
          tg`Клиент: ${result.clientName}\n` +
          tg`Чат: ${code(result.clientChatId)}\n` +
          tg`Риск: ${result.riskLevel}\n\n` +
          tg`Возможно, бот не в группе или чат не существует\. Проверь ${code('/groups')}\.`,
      };

    case 'error':
      return { text: tg`❌ *Ошибка:* ${result.error}` };
  }
}

function makePendingToken(safeTxHash: string): string {
  return safeTxHash.slice(2, 18);
}

async function storePendingUrl(token: string, url: string, adminId: number): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis.setex(
      `manual_analyze:pending:${token}:${adminId}`,
      PENDING_URL_TTL_SEC,
      url
    );
  } catch (error) {
    logger.error({ error }, 'Failed to store pending URL in Redis');
  }
}

async function fetchPendingUrl(token: string, adminId: number): Promise<string | null> {
  if (!isRedisAvailable()) return null;
  try {
    return await redis.get(`manual_analyze:pending:${token}:${adminId}`);
  } catch {
    return null;
  }
}

interface PendingTokenInput {
  chainId: number;
  address: string;
}

async function setPendingTokenInput(adminId: number, info: PendingTokenInput): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis.setex(`pending_token:${adminId}`, PENDING_TOKEN_TTL_SEC, JSON.stringify(info));
  } catch (error) {
    logger.error({ error }, 'Failed to store pending token input');
  }
}

async function getPendingTokenInput(adminId: number): Promise<PendingTokenInput | null> {
  if (!isRedisAvailable()) return null;
  try {
    const raw = await redis.get(`pending_token:${adminId}`);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

async function clearPendingTokenInput(adminId: number): Promise<void> {
  if (!isRedisAvailable()) return;
  try {
    await redis.del(`pending_token:${adminId}`);
  } catch {  }
}

async function sendUnresolvedTokensFollowup(
  bot: Bot<BotContext>,
  adminChatId: number,
  chainId: number,
  addresses: string[],
): Promise<void> {
  if (addresses.length === 0) return;
  const lines = [
    tg`⚠️ *Не распознаны токены* \(сеть chainId\=${chainId}\)`,
    '',
    tg`Можно добавить их в реестр, чтобы в следующий раз символ показывался автоматически\.`,
    '',
  ];

  for (const addr of addresses) {
    lines.push(tg`• ${code(addr)}`);
  }

  const kb = new InlineKeyboard();
  for (const addr of addresses) {
    const short = `${addr.slice(0, 8)}…${addr.slice(-6)}`;
    kb.text(`✏️ Добавить ${short}`, `tok:add:${chainId}:${addr.toLowerCase()}`).row();
  }

  try {
    await bot.api.sendMessage(adminChatId, lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
  } catch (error) {
    logger.error({ error, adminChatId, addresses }, 'Failed to send unresolved tokens follow-up');
  }
}

async function runAnalysis(
  bot: Bot<BotContext>,
  url: string,
  adminId: number,
  adminName: string | undefined,
  msg: ProgressMessage,
  allowDuplicate: boolean
): Promise<void> {
  const stageHistory: AnalyzeStage[] = [];

  let result: AnalyzeResult;
  try {
    result = await analyzeBySafeUrl(url, {
      adminId,
      adminName,
      allowDuplicate,
      onProgress: async (stage) => {
        stageHistory.push(stage);
        await updateProgress(bot, msg, stage, stageHistory);
      },
    });
  } catch (error) {
    logger.error({ error, url }, 'Manual analysis crashed');
    result = {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (result.status === 'already_analyzed') {
    const token = makePendingToken(result.safeTxHash);
    await storePendingUrl(token, url, adminId);
  }

  const { text, keyboard } = formatResultMessage(result);
  try {
    await bot.api.editMessageText(msg.chatId, msg.messageId, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  } catch (error) {
    logger.error({ error }, 'Failed to send final result, falling back to plain reply');
    await bot.api.sendMessage(msg.chatId, text, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  }

  if ((result.status === 'ok' || result.status === 'notification_failed') && result.unresolvedTokens.length > 0) {
    await sendUnresolvedTokensFollowup(bot, msg.chatId, result.chainId, result.unresolvedTokens);
  }
}

export function setupManualAnalyzeHandlers(bot: Bot<BotContext>): void {
  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();

    const userId = ctx.from?.id;
    if (!userId) return next();

    const text = ctx.message.text.trim();

    if (text.startsWith('/')) return next();

    const pending = await getPendingTokenInput(userId);
    if (pending) {
      const isAdmin = await checkIsAdmin(userId);
      if (!isAdmin) return next();

      const match = text.match(/^([a-zA-Z0-9._-]{1,32})\s+(\d{1,2})$/);
      if (!match) {
        await ctx.reply(
          tg`❌ Формат: ${code('SYMBOL DECIMALS')}\nНапример: ${code('USDC 6')}\n\nПопробуй ещё раз или нажми /cancel`,
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }
      const [, symbol, decimalsStr] = match;
      const decimals = parseInt(decimalsStr, 10);
      if (decimals < 0 || decimals > 30) {
        await ctx.reply(tg`❌ Decimals должно быть от 0 до 30`, { parse_mode: 'MarkdownV2' });
        return;
      }
      try {
        await setManualToken(pending.chainId, pending.address, symbol, decimals);
        await clearPendingTokenInput(userId);
        await ctx.reply(
          tg`✅ Сохранено: ${code(pending.address)}\nchainId\=${pending.chainId} · ${symbol} · ${decimals} decimals`,
          { parse_mode: 'MarkdownV2' }
        );
      } catch (error) {
        logger.error({ error, pending }, 'Failed to save manual token');
        await ctx.reply(tg`❌ Ошибка сохранения: ${error instanceof Error ? error.message : String(error)}`, { parse_mode: 'MarkdownV2' });
      }
      return;
    }

    const urls = extractSafeUrls(text);
    if (urls.length === 0) return next();

    const isAdmin = await checkIsAdmin(userId);
    if (!isAdmin) {
      return next();
    }

    const allowed = await checkRateLimit(`manual_analyze:${userId}`, RATE_LIMIT_PER_MIN, 60);
    if (!allowed) {
      await ctx.reply(
        `🚫 Лимит: не более ${RATE_LIMIT_PER_MIN} ручных анализов в минуту\\. Попробуйте через минуту\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    for (const url of urls) {
      const initial = await ctx.reply('⏳ *Ручной анализ транзакции*', { parse_mode: 'MarkdownV2' });
      await runAnalysis(
        bot,
        url,
        userId,
        ctx.from?.username || ctx.from?.first_name || undefined,
        { chatId: initial.chat.id, messageId: initial.message_id },
        false
      );
    }
  });

  bot.callbackQuery(/^tok:add:(\d+):(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!(await checkIsAdmin(userId))) {
      await ctx.answerCallbackQuery({ text: 'Только администратор', show_alert: true });
      return;
    }
    const chainId = parseInt(ctx.match![1], 10);
    const address = ctx.match![2];
    await setPendingTokenInput(userId, { chainId, address });
    await ctx.answerCallbackQuery();
    await ctx.reply(
      tg`✏️ Введи для ${code(address)} \(chainId\=${chainId}\):\n\nФормат: ${code('SYMBOL DECIMALS')}\nНапример: ${code('USDC 6')} или ${code('PEPE 18')}\n\nОтменить: /cancel`,
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.command('cancel', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from?.id;
    if (!userId) return;
    const pending = await getPendingTokenInput(userId);
    if (pending) {
      await clearPendingTokenInput(userId);
      await ctx.reply('✅ Ввод токена отменён');
    }
  });

  bot.callbackQuery(/^manual:repeat:([a-f0-9]+)$/, async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (!(await checkIsAdmin(userId))) {
      await ctx.answerCallbackQuery({ text: 'Только администратор', show_alert: true });
      return;
    }

    const token = ctx.match![1];
    const url = await fetchPendingUrl(token, userId);
    if (!url) {
      await ctx.answerCallbackQuery({ text: 'Срок действия истёк, отправьте ссылку снова', show_alert: true });
      return;
    }

    await ctx.answerCallbackQuery();

    if (!ctx.chat || !ctx.callbackQuery.message) return;

    await ctx.editMessageText('⏳ *Повторный анализ*', { parse_mode: 'MarkdownV2' });
    await runAnalysis(
      bot,
      url,
      userId,
      ctx.from?.username || ctx.from?.first_name || undefined,
      { chatId: ctx.chat.id, messageId: ctx.callbackQuery.message.message_id },
      true
    );
  });
}
