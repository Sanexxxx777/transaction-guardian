import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { audit } from '../../audit-log/index.js';

const PREFIX = 'allowed';

export function setupAllowedUsersHandlers(bot: Bot<BotContext>): void {
  bot.command('allowed', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;
    await showAllowedList(ctx);
  });

  bot.callbackQuery(new RegExp(`^${PREFIX}:`), async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }

    const data = ctx.callbackQuery.data;
    const [, action, ...params] = data.split(':');
    await ctx.answerCallbackQuery();

    switch (action) {
      case 'list':
        await showAllowedList(ctx);
        break;
      case 'add':
        await startAddAllowed(ctx);
        break;
      case 'remove_confirm':
        await confirmRemove(ctx, params[0]);
        break;
      case 'remove_ok':
        await doRemove(ctx, params[0]);
        break;
    }
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    if (ctx.session.step !== 'allowed:add') return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return next();
    }

    const parts = text.split(' ');
    const rawId = parts[0];
    const note = parts.slice(1).join(' ') || undefined;

    const userId = parseInt(rawId, 10);
    if (isNaN(userId) || userId <= 0) {
      await ctx.reply(
        '❌ Неверный формат\\. Введите Telegram ID пользователя \\(число\\)\\.\n\n' +
        'Пример: `821510091` или `821510091 Дмитрий Сидни`',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    ctx.session.step = undefined;

    try {
      const existingClient = await prisma.client.findUnique({
        where: { telegramUserId: BigInt(userId) },
        select: { name: true },
      });
      if (existingClient) {
        const kb = new InlineKeyboard()
          .text('← Список', `${PREFIX}:list`)
          .text('🏠 Меню', 'menu:back_admin');
        await ctx.reply(
          `⚠️ Пользователь \`${userId}\` уже зарегистрирован как клиент *${escapeMarkdown(existingClient.name)}*\\.`,
          { parse_mode: 'MarkdownV2', reply_markup: kb }
        );
        return;
      }

      const allowed = await prisma.allowedUser.upsert({
        where: { telegramUserId: BigInt(userId) },
        update: { note: note ?? null },
        create: {
          telegramUserId: BigInt(userId),
          note,
        },
      });

      await audit({
        action: 'allowed_user.add',
        actorId: ctx.from?.id,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: allowed.id,
        targetType: 'allowed_user',
        details: { telegramUserId: userId, note },
      });

      const kb = new InlineKeyboard()
        .text('➕ Ещё', `${PREFIX}:add`)
        .text('← Список', `${PREFIX}:list`)
        .row()
        .text('🏠 Меню', 'menu:back_admin');

      await ctx.reply(
        `✅ Пользователь *${userId}*${note ? ` \\(${escapeMarkdown(note)}\\)` : ''} добавлен в список допуска\\.`,
        { parse_mode: 'MarkdownV2', reply_markup: kb }
      );
    } catch {
      ctx.session.step = undefined;
      await ctx.reply('❌ Ошибка добавления\\.');
    }
  });
}

async function showAllowedList(ctx: BotContext): Promise<void> {
  const users = await prisma.allowedUser.findMany({
    orderBy: { createdAt: 'desc' },
  });

  const registrationOpen = process.env.REGISTRATION_OPEN !== 'false';

  let text = `👥 *Допуски к регистрации*\n\n`;
  text += registrationOpen
    ? `🔓 Режим: *открытая регистрация* \\(REGISTRATION\\_OPEN=true\\)\n`
    : `🔒 Режим: *только по списку* \\(REGISTRATION\\_OPEN=false\\)\n`;
  text += `\n`;

  const kb = new InlineKeyboard();

  if (users.length === 0) {
    text += 'Список пуст\\.';
  } else {
    text += `Записей: *${users.length}*\n\n`;
    for (const u of users.slice(0, 10)) {
      const label = u.note ? `${u.telegramUserId} — ${u.note}` : String(u.telegramUserId);
      text += `• \`${u.telegramUserId}\`${u.note ? ` — ${escapeMarkdown(u.note)}` : ''}\n`;
      kb.text(`❌ ${label.slice(0, 30)}`, `${PREFIX}:remove_confirm:${u.id}`).row();
    }
  }

  kb.text('➕ Добавить', `${PREFIX}:add`).row();
  kb.text('🏠 Главное меню', 'menu:back_admin');

  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

async function startAddAllowed(ctx: BotContext): Promise<void> {
  ctx.session.step = 'allowed:add';
  const kb = new InlineKeyboard().text('← Отмена', `${PREFIX}:list`);
  const text =
    '➕ *Добавить пользователя*\n\n' +
    'Введите Telegram ID пользователя и опционально заметку:\n\n' +
    '_Формат: `<id> [имя]`_\n' +
    '_Пример: `821510091 Дмитрий Сидни`_\n\n' +
    '💡 Чтобы узнать ID — попросите пользователя написать /chatid боту';
  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

async function confirmRemove(ctx: BotContext, allowedId: string): Promise<void> {
  const user = await prisma.allowedUser.findUnique({ where: { id: allowedId } });
  if (!user) return;

  const label = user.note ? `${user.telegramUserId} \\(${escapeMarkdown(user.note)}\\)` : String(user.telegramUserId);
  const kb = new InlineKeyboard()
    .text('Да, удалить', `${PREFIX}:remove_ok:${allowedId}`)
    .text('← Отмена', `${PREFIX}:list`);

  await ctx.editMessageText(
    `⚠️ *Убрать из допуска?*\n\n${label}`,
    { parse_mode: 'MarkdownV2', reply_markup: kb }
  );
}

async function doRemove(ctx: BotContext, allowedId: string): Promise<void> {
  const user = await prisma.allowedUser.findUnique({ where: { id: allowedId } });
  if (!user) {
    await showAllowedList(ctx);
    return;
  }

  await prisma.allowedUser.delete({ where: { id: allowedId } });

  await audit({
    action: 'allowed_user.remove',
    actorId: ctx.from?.id,
    actorName: ctx.from?.username || ctx.from?.first_name,
    targetId: allowedId,
    targetType: 'allowed_user',
    details: { telegramUserId: Number(user.telegramUserId) },
  });

  await showAllowedList(ctx);
}
