import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';

const CALLBACK_PREFIX = 'admin_net';

export function setupNetworksHandlers(bot: Bot<BotContext>): void {
  bot.command('networks', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;

    const networks = await prisma.network.findMany({
      orderBy: { name: 'asc' },
    });

    const keyboard = new InlineKeyboard();
    let row = 0;

    for (const network of networks) {
      const status = network.isEnabled ? '✅' : '⚪';
      keyboard.text(
        `${status} ${network.shortName}`,
        `${CALLBACK_PREFIX}:toggle:${network.chainId}`
      );

      row++;
      if (row % 2 === 0) {
        keyboard.row();
      }
    }

    await ctx.reply(
      '🌐 *Сети*\n\n' +
      'Нажмите чтобы вкл/выкл',
      {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      }
    );
  });

  bot.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}:`), async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }

    const data = ctx.callbackQuery.data;
    const [, action, param] = data.split(':');

    if (action === 'toggle') {
      const chainId = parseInt(param);

      const network = await prisma.network.findUnique({
        where: { chainId },
      });

      if (network) {
        await prisma.network.update({
          where: { chainId },
          data: { isEnabled: !network.isEnabled },
        });
      }

      const networks = await prisma.network.findMany({
        orderBy: { name: 'asc' },
      });

      const keyboard = new InlineKeyboard();
      let row = 0;

      for (const n of networks) {
        const status = n.isEnabled ? '✅' : '⚪';
        keyboard.text(
          `${status} ${n.shortName}`,
          `${CALLBACK_PREFIX}:toggle:${n.chainId}`
        );

        row++;
        if (row % 2 === 0) {
          keyboard.row();
        }
      }

      await ctx.editMessageReplyMarkup({ reply_markup: keyboard });
    }

    await ctx.answerCallbackQuery();
  });
}
