import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown, formatAddress } from '../../../utils/formatters.js';
import { scanApprovals, type ApprovalEntry } from '../../approval-scanner/index.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('user-approvals');

export function setupUserApprovalsHandlers(bot: Bot<BotContext>): void {
  bot.command('approvals', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const userId = ctx.from?.id;
    if (!userId) return;

    const client = await prisma.client.findUnique({
      where: { telegramUserId: BigInt(userId) },
      select: { id: true, tier: true },
    });

    if (!client) {
      await ctx.reply('Вы не зарегистрированы\\. Используйте /start', { parse_mode: 'MarkdownV2' });
      return;
    }

    const wallets = await prisma.wallet.findMany({
      where: { clientId: client.id, isActive: true },
      select: { id: true, address: true, chainId: true, name: true },
    });

    if (wallets.length === 0) {
      await ctx.reply('У вас нет активных кошельков\\. Добавьте через /wallets', { parse_mode: 'MarkdownV2' });
      return;
    }

    if (wallets.length === 1) {
      await scanAndSend(ctx, wallets[0].address, wallets[0].chainId, wallets[0].name);
    } else {
      const kb = new InlineKeyboard();
      for (const w of wallets) {
        const label = w.name || formatAddress(w.address);
        kb.text(label, `ua:scan:${w.address}:${w.chainId}`).row();
      }
      await ctx.reply(
        '🔍 *Approval Radar*\n\nВыберите кошелёк для сканирования:',
        { parse_mode: 'MarkdownV2', reply_markup: kb }
      );
    }
  });

  bot.callbackQuery(/^ua:scan:/, async (ctx) => {
    await ctx.answerCallbackQuery('Сканирую...');
    const parts = ctx.callbackQuery.data.split(':');
    if (parts.length < 4) return;

    const address = parts[2];
    const chainId = parseInt(parts[3]);
    if (isNaN(chainId)) return;

    await scanAndSend(ctx, address, chainId, null, true);
  });
}

async function scanAndSend(
  ctx: BotContext,
  address: string,
  chainId: number,
  walletName: string | null,
  edit = false
): Promise<void> {
  try {
    const approvals = await scanApprovals(address, chainId);

    const network = await prisma.network.findUnique({
      where: { chainId },
      select: { name: true },
    });

    const walletLabel = walletName || formatAddress(address);
    let text = `🔍 *Approval Radar*\n`;
    text += `👛 ${escapeMarkdown(walletLabel)} \\| ${escapeMarkdown(network?.name || 'Unknown')}\n\n`;

    if (approvals.length === 0) {
      text += '✅ _Нет активных approvals\\._';
    } else {
      approvals.sort((a, b) => {
        if (a.isUnlimited !== b.isUnlimited) return a.isUnlimited ? -1 : 1;
        return b.blockNumber - a.blockNumber;
      });

      const dangerCount = approvals.filter(a => a.isUnlimited).length;
      if (dangerCount > 0) {
        text += `🔴 *${dangerCount} безлимитных approvals\\!*\n\n`;
      }

      text += `Найдено *${approvals.length}* активных approvals:\n\n`;

      for (const a of approvals.slice(0, 15)) {
        const risk = a.isUnlimited ? '🔴' : '🟡';
        const amount = a.isUnlimited ? 'Безлимитный' : 'Ограниченный';
        const tokenLabel = a.tokenSymbol || formatAddress(a.tokenAddress);
        const spenderLabel = formatAddress(a.spender);

        text += `${risk} *${escapeMarkdown(tokenLabel)}*\n`;
        text += `   Spender: \`${escapeMarkdown(spenderLabel)}\`\n`;
        text += `   ${escapeMarkdown(amount)}\n\n`;
      }

      if (approvals.length > 15) {
        text += `_\\.\\.\\.и ещё ${approvals.length - 15}_\n`;
      }
    }

    const method = edit ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
    await method(text, { parse_mode: 'MarkdownV2' as const });
  } catch (error) {
    logger.error({ error, address, chainId }, 'Failed to scan approvals');
    const method = edit ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
    await method('❌ Ошибка сканирования\\. Попробуйте позже\\.', { parse_mode: 'MarkdownV2' as const });
  }
}
