import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown, formatRelativeTime, formatAddress } from '../../../utils/formatters.js';

const PAGE_SIZE = 10;
const CALLBACK_PREFIX = 'uh';

export function setupUserHistoryHandlers(bot: Bot<BotContext>): void {
  bot.command('history', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const { checkIsAdmin } = await import('../index.js');
    if (await checkIsAdmin(userId)) {
      await sendAllHistoryPage(ctx, 0);
      return;
    }

    const client = await prisma.client.findUnique({
      where: { telegramUserId: BigInt(userId) },
      select: { id: true },
    });

    if (!client) {
      await ctx.reply(
        'История доступна в группе с администратором\\.\n' +
        'Для подключения обратитесь к администратору',
        { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
      );
      return;
    }

    await sendUserHistoryPage(ctx, client.id, 0);
  });

  bot.callbackQuery(/^ah:all:/, async (ctx) => {
    const page = parseInt(ctx.callbackQuery.data.split(':')[2]);
    if (isNaN(page)) return;
    await ctx.answerCallbackQuery();
    await sendAllHistoryPage(ctx, page, true);
  });

  bot.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}:`), async (ctx) => {
    const data = ctx.callbackQuery.data;
    const parts = data.split(':');
    if (parts.length < 3) return;

    const clientId = parts[1];
    const page = parseInt(parts[2]);
    if (isNaN(page)) return;

    await ctx.answerCallbackQuery();
    await sendUserHistoryPage(ctx, clientId, page, true);
  });
}

async function sendUserHistoryPage(
  ctx: BotContext,
  clientId: string,
  page: number,
  edit = false
): Promise<void> {
  const skip = page * PAGE_SIZE;

  const walletIds = (await prisma.wallet.findMany({
    where: { clientId, isActive: true },
    select: { id: true },
  })).map(w => w.id);

  if (walletIds.length === 0) {
    const text = '📜 *История транзакций*\n\n_Нет кошельков\\._';
    const method = edit ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
    await method(text, { parse_mode: 'MarkdownV2' as const });
    return;
  }

  const [transactions, total] = await Promise.all([
    prisma.transactionHistory.findMany({
      where: { walletId: { in: walletIds } },
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      skip,
      include: {
        wallet: { select: { address: true, chainId: true } },
      },
    }),
    prisma.transactionHistory.count({
      where: { walletId: { in: walletIds } },
    }),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  let text = `📜 *История транзакций* \\(${escapeMarkdown(String(total))} всего\\)\n\n`;

  if (transactions.length === 0) {
    text += '_Транзакций пока нет\\._';
  } else {
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const num = skip + i + 1;
      const statusEmoji = getStatusEmoji(tx.status);
      const riskEmoji = getRiskEmoji(tx.riskLevel);
      const time = formatRelativeTime(tx.createdAt);

      let methodOrRecipient = '';
      if (tx.decodedMethod) {
        methodOrRecipient = tx.decodedMethod;
      } else {
        methodOrRecipient = `→ ${formatAddress(tx.toAddress)}`;
      }

      text += `\`${escapeMarkdown(String(num))}\\.\` ${statusEmoji}${riskEmoji} ${escapeMarkdown(methodOrRecipient)}\n`;
      text += `    _${escapeMarkdown(time)}_\n`;
    }
  }

  const kb = new InlineKeyboard();

  if (page > 0) {
    kb.text('← Назад', `${CALLBACK_PREFIX}:${clientId}:${page - 1}`);
  }

  kb.text(`${page + 1}/${totalPages}`, 'noop');

  if (page < totalPages - 1) {
    kb.text('Далее →', `${CALLBACK_PREFIX}:${clientId}:${page + 1}`);
  }

  kb.row().text('← Главное меню', 'menu:back_user');

  const options = {
    parse_mode: 'MarkdownV2' as const,
    reply_markup: kb,
  };

  if (edit) {
    await ctx.editMessageText(text, options);
  } else {
    await ctx.reply(text, options);
  }
}

async function sendAllHistoryPage(
  ctx: BotContext,
  page: number,
  edit = false
): Promise<void> {
  const skip = page * PAGE_SIZE;

  const [transactions, total] = await Promise.all([
    prisma.transactionHistory.findMany({
      orderBy: { createdAt: 'desc' },
      take: PAGE_SIZE,
      skip,
      include: {
        wallet: { select: { address: true, chainId: true, client: { select: { name: true } } } },
      },
    }),
    prisma.transactionHistory.count(),
  ]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  let text = `📜 *Все транзакции* \\(${escapeMarkdown(String(total))}\\)\n\n`;

  if (transactions.length === 0) {
    text += '_Транзакций пока нет\\._';
  } else {
    for (let i = 0; i < transactions.length; i++) {
      const tx = transactions[i];
      const num = skip + i + 1;
      const statusEmoji = getStatusEmoji(tx.status);
      const riskEmoji = getRiskEmoji(tx.riskLevel);
      const time = formatRelativeTime(tx.createdAt);
      const group = tx.wallet?.client?.name || '?';
      const method = tx.decodedMethod || `→ ${formatAddress(tx.toAddress)}`;

      text += `\`${escapeMarkdown(String(num))}\\.\` ${statusEmoji}${riskEmoji} ${escapeMarkdown(method)}\n`;
      text += `    _${escapeMarkdown(group)} · ${escapeMarkdown(time)}_\n`;
    }
  }

  const kb = new InlineKeyboard();
  if (page > 0) kb.text('← Назад', `ah:all:${page - 1}`);
  kb.text(`${page + 1}/${totalPages}`, 'noop');
  if (page < totalPages - 1) kb.text('Далее →', `ah:all:${page + 1}`);
  kb.row().text('← Главное меню', 'menu:back_admin');

  if (edit) {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

function getStatusEmoji(status: string): string {
  switch (status) {
    case 'executed': return '✅';
    case 'pending': return '⏳';
    case 'signed': return '✍️';
    case 'rejected': return '🚫';
    case 'failed': return '❌';
    default: return '❓';
  }
}

function getRiskEmoji(riskLevel: string | null): string {
  switch (riskLevel) {
    case 'danger': return '🔴';
    case 'warning': return '🟡';
    case 'ok': return '';
    default: return '';
  }
}
