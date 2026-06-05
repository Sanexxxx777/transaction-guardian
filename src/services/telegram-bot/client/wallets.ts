import { Bot } from 'grammy';
import type { BotContext } from '../index.js';
import { getClientByChatId } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown, formatAddress } from '../../../utils/formatters.js';

export function setupWalletsHandler(bot: Bot<BotContext>): void {
  bot.command('wallets', async (ctx, next) => {
    if (ctx.chat?.type === 'private') return next();

    const client = await getClientByChatId(ctx.chat.id);
    if (!client) {
      await ctx.reply('⚠️ Этот чат не привязан к клиенту\\.');
      return;
    }

    const wallets = await prisma.wallet.findMany({
      where: { clientId: client.id, isActive: true },
      orderBy: { createdAt: 'asc' },
    });

    const networks = await prisma.network.findMany({
      select: { chainId: true, name: true, shortName: true },
    });
    const networkMap = new Map(networks.map((n) => [n.chainId, n]));

    let text = `💼 *Ваши кошельки*\n\n`;

    if (wallets.length === 0) {
      text += 'Кошельков пока нет\\.\n\nОбратитесь к администратору для добавления\\.';
    } else {
      const walletsByAddress = new Map<string, typeof wallets>();
      for (const wallet of wallets) {
        const key = wallet.address.toLowerCase();
        const existing = walletsByAddress.get(key) || [];
        existing.push(wallet);
        walletsByAddress.set(key, existing);
      }

      let num = 1;
      for (const [, addressWallets] of walletsByAddress) {
        const first = addressWallets[0];
        const name = first.name || `Кошелёк ${num}`;
        const chains = addressWallets
          .map((w) => networkMap.get(w.chainId)?.shortName || `Chain ${w.chainId}`)
          .join(', ');

        text += `${num}️⃣ *${escapeMarkdown(name)}*\n`;
        text += `   \`${escapeMarkdown(first.address)}\`\n`;
        text += `   Сети: ${escapeMarkdown(chains)}\n\n`;

        num++;
      }

      text += `Всего кошельков: ${walletsByAddress.size}`;
    }

    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  });
}
