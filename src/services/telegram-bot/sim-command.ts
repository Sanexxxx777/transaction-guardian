import { Bot, Context, InlineKeyboard } from 'grammy';
import type { BotContext } from './index.js';
import { checkIsAdmin, getBotUsername } from './index.js';
import { checkRateLimit } from '../../db/redis.js';
import { tg, code } from '../../utils/tg-md.js';
import { escapeMarkdown } from '../../utils/formatters.js';
import { createLogger } from '../../utils/logger.js';
import { extractSafeUrls } from '../manual-analyze/url-parser.js';
import { analyzeBySafeUrl, type AnalyzeResult, type AnalyzeStage } from '../manual-analyze/index.js';

const logger = createLogger('sim-command');

const RATE_LIMIT_PER_MIN = 10;

const STAGE_LABELS: Record<AnalyzeStage, string> = {
  parsing: '🔗 Парсинг URL...',
  wallet_lookup: '🔍 Поиск кошелька...',
  safe_api: '☁️ Запрос Safe API...',
  simulation: '🧪 Симуляция Tenderly...',
  policy: '📋 Проверка политик...',
  ai: '🤖 AI-анализ...',
  sending: '📤 Отправка результата...',
  done: '✅ Готово',
};

const HELP_TEXT = tg`Использование: ${code('/sim <ссылка на транзакцию Safe>')}\n\nПример:\n${code('/sim https://app.safe.global/transactions/tx?safe=eth:0x...&id=multisig_0x..._0x...')}`;

export function setupSimCommand(bot: Bot<BotContext>): void {
  bot.command('sim', async (ctx) => {
    const text = (ctx.message?.text || '').trim();
    const argsStart = text.indexOf(' ');
    const args = argsStart >= 0 ? text.slice(argsStart + 1).trim() : '';
    await runSim(ctx, args, { isExplicitCommand: true });
  });

  bot.on('message:text', async (ctx, next) => {
    const text = ctx.message.text || '';
    if (text.trimStart().startsWith('/sim')) return next();
    const m = text.match(/(?:^|\s)\/sim(?:@\w+)?\s+(\S+)/i);
    if (!m) return next();
    await runSim(ctx, m[1], { isExplicitCommand: false });
  });
}

interface RunSimOpts {
  isExplicitCommand: boolean;
}

async function runSim(ctx: Context, args: string, opts: RunSimOpts): Promise<void> {
  const userId = ctx.from?.id;
  const chat = ctx.chat;
  if (!userId || !chat) return;

  const isPrivate = chat.type === 'private';
  if (isPrivate && !(await checkIsAdmin(userId))) {
    await ctx.reply(tg`⛔ В личных сообщениях команда ${code('/sim')} доступна только администраторам\.`, {
      parse_mode: 'MarkdownV2',
    });
    return;
  }

  if (!args) {
    if (opts.isExplicitCommand) {
      await ctx.reply(HELP_TEXT, { parse_mode: 'MarkdownV2' });
    }
    return;
  }

  const urls = extractSafeUrls(args);
  if (urls.length === 0) {
    if (opts.isExplicitCommand) {
      await ctx.reply(
        tg`❌ Не нашёл ссылку на транзакцию Safe\.\n\n` + HELP_TEXT,
        { parse_mode: 'MarkdownV2' },
      );
    }
    return;
  }

  const allowed = await checkRateLimit(`sim:${userId}`, RATE_LIMIT_PER_MIN, 60);
  if (!allowed) {
    await ctx.reply(
      tg`🚫 Лимит: не более ${String(RATE_LIMIT_PER_MIN)} симуляций в минуту\. Подождите минуту\.`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  for (const url of urls) {
    const progressMsg = await ctx.reply('⏳ *Симуляция транзакции*', {
      parse_mode: 'MarkdownV2',
    });

    const stageHistory: AnalyzeStage[] = [];
    let result: AnalyzeResult;
    try {
      result = await analyzeBySafeUrl(url, {
        adminId: userId,
        adminName: ctx.from?.username || ctx.from?.first_name || undefined,
        allowDuplicate: true,
        targetChatId: BigInt(chat.id),
        onProgress: async (stage) => {
          stageHistory.push(stage);
          const lines = stageHistory.map(s => (s === stage ? `▸ ${STAGE_LABELS[s]}` : `· ${STAGE_LABELS[s]}`));
          const progressText = '⏳ *Симуляция транзакции*\n\n' + lines.map(escapeMarkdown).join('\n');
          try {
            await ctx.api.editMessageText(progressMsg.chat.id, progressMsg.message_id, progressText, {
              parse_mode: 'MarkdownV2',
            });
          } catch {
          }
        },
      });
    } catch (error) {
      logger.error({ error, url }, '/sim crashed');
      result = { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }

    const requesterIsAdmin = await checkIsAdmin(userId);
    const formatted = formatSimResult(result, { requesterIsAdmin, isPrivate });
    if (formatted === null) {
      try {
        await ctx.api.deleteMessage(progressMsg.chat.id, progressMsg.message_id);
      } catch (error) {
        logger.warn({ error }, 'Failed to delete progress message after successful sim');
      }
      continue;
    }
    const { text: finalText, keyboard } = formatted;
    try {
      await ctx.api.editMessageText(progressMsg.chat.id, progressMsg.message_id, finalText, {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      });
    } catch (error) {
      logger.error({ error }, 'Failed to edit progress message, sending fresh reply');
      await ctx.reply(finalText, { parse_mode: 'MarkdownV2', reply_markup: keyboard });
    }
  }
}

interface FormatOpts {
  requesterIsAdmin: boolean;
  isPrivate: boolean;
}

function formatSimResult(result: AnalyzeResult, opts: FormatOpts): { text: string; keyboard?: InlineKeyboard } | null {
  switch (result.status) {
    case 'ok':
      return null;

    case 'invalid_url':
      return { text: tg`❌ ${result.error}` };

    case 'wallet_not_found': {
      const baseText =
        tg`❌ Кошелёк ${code(result.address)} не зарегистрирован\n` +
        tg`\(сеть chainId\=${result.chainId}\)\n\n`;

      if (opts.requesterIsAdmin) {
        if (opts.isPrivate) {
          const kb = new InlineKeyboard().text(
            '➕ Добавить во все сети',
            `aw:dl:${result.address.toLowerCase()}`,
          );
          return {
            text: baseText + tg`Запустить сканирование сетей и добавить?`,
            keyboard: kb,
          };
        }
        const username = getBotUsername();
        if (username) {
          const url = `https://t.me/${username}?start=aw_${result.address.toLowerCase()}`;
          const kb = new InlineKeyboard().url('➕ Добавить в боте (в личке)', url);
          return {
            text: baseText + tg`Откройте бота в личке, чтобы добавить этот кошелёк:`,
            keyboard: kb,
          };
        }
        return {
          text:
            baseText +
            tg`Добавьте через админку: ${code('/start')} в личке с ботом → 👛 Кошельки → ➕ Добавить кошелёк\.`,
        };
      }

      return {
        text:
          baseText +
          tg`Попросите администратора добавить этот кошелёк в боте\.`,
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
      const kind = result.info.isMonthlyQuota ? 'месячная квота Safe API исчерпана' : 'rate limit Safe API';
      return {
        text:
          tg`🚫 ${kind}\n\n` +
          tg`Reset через ~${String(resetMin)} мин\.`,
      };
    }

    case 'already_analyzed':

      return {
        text:
          tg`⚠️ Эта транзакция уже анализировалась\n` +
          tg`Текущий статус: ${code(result.existingStatus)}`,
      };

    case 'notification_failed':
      return {
        text:
          tg`⚠️ Анализ выполнен, но отправить результат в чат не удалось\.\n` +
          tg`Возможно, у бота нет прав на отправку сообщений\.`,
      };

    case 'error':
      return { text: tg`❌ Ошибка: ${result.error}` };
  }
}
