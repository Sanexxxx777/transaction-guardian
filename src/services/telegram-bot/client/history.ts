import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { getClientByChatId } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown, formatRelativeTime, formatAddress } from '../../../utils/formatters.js';

const PAGE_SIZE = 5;
const CALLBACK_PREFIX = 'client_history';

export function setupHistoryHandler(bot: Bot<BotContext>): void {
  bot.command('history', async (ctx, next) => {
    if (ctx.chat?.type === 'private') return next();

    const client = await getClientByChatId(ctx.chat.id);
    if (!client) {
      await ctx.reply('⚠️ Этот чат не привязан к клиенту\\.');
      return;
    }

    await sendHistoryPage(ctx, client.id, 0);
  });

  bot.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}:`), async (ctx) => {
    const data = ctx.callbackQuery.data;
    const [, clientId, pageStr] = data.split(':');
    const page = parseInt(pageStr);

    await sendHistoryPage(ctx, clientId, page, true);
    await ctx.answerCallbackQuery();
  });
}

async function sendHistoryPage(
  ctx: BotContext,
  clientId: string,
  page: number,
  edit = false
): Promise<void> {
  const skip = page * PAGE_SIZE;

  const [transactions, total] = await Promise.all([
    prisma.transactionHistory.findMany({
      where: { wallet: { clientId } },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      skip,
      include: {
        wallet: {
          select: { address: true, name: true, chainId: true },
        },
      },
    }),
    prisma.transactionHistory.count({
      where: { wallet: { clientId } },
    }),
  ]);

  const totalPages = Math.ceil(total / PAGE_SIZE);

  let text = `📜 *История транзакций*\n\n`;

  if (transactions.length === 0) {
    text += 'Транзакций пока нет\\.';
  } else {
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const num = skip + i + 1;
      const statusEmoji = getStatusEmoji(tx.status);
      const time = formatRelativeTime(tx.createdAt);

      text += `${num}️⃣ ${statusEmoji} ${escapeMarkdown(tx.status)} • ${escapeMarkdown(time)}\n`;

      if (tx.decodedMethod) {
        text += `   ${escapeMarkdown(tx.decodedMethod)}\n`;
      } else {
        text += `   To: \`${escapeMarkdown(formatAddress(tx.toAddress))}\`\n`;
      }

      text += '\n';
    }
  }

  const keyboard = new InlineKeyboard();

  if (page > 0) {
    keyboard.text('← Назад', `${CALLBACK_PREFIX}:${clientId}:${page - 1}`);
  }

  keyboard.text(`${page + 1}/${totalPages}`, 'noop');

  if (page < totalPages - 1) {
    keyboard.text('Вперёд →', `${CALLBACK_PREFIX}:${clientId}:${page + 1}`);
  }

  const options = {
    parse_mode: 'MarkdownV2' as const,
    reply_markup: keyboard,
  };

  if (edit) {
    await ctx.editMessageText(text, options);
  } else {
    await ctx.reply(text, options);
  }
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'executed':
      return '✅';
    case 'pending':
      return '⏳';
    case 'signed':
      return '✍️';
    case 'rejected':
      return '🚫';
    case 'failed':
      return '❌';
    default:
      return '❓';
  }
}
