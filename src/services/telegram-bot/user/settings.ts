import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { prisma } from '../../../db/index.js';
import { createLogger } from '../../../utils/logger.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { audit } from '../../audit-log/index.js';
import { getTierLimits } from '../../tier-manager/index.js';

const logger = createLogger('user-settings');

export function setupUserSettingsHandlers(bot: Bot<BotContext>): void {
  bot.command('plan', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const client = await getClientByUserId(ctx.from?.id);
    if (!client) {
      await ctx.reply('Вы не зарегистрированы\\. Используйте /start', { parse_mode: 'MarkdownV2' });
      return;
    }
    await showPlanInfo(ctx, client, false);
  });

  bot.callbackQuery('us:plan', async (ctx) => {
    await ctx.answerCallbackQuery();
    const client = await getClientByUserId(ctx.from?.id);
    if (!client) return;
    await showPlanInfo(ctx, client, true);
  });

  bot.callbackQuery('menu:user_help', async (ctx) => {
    await ctx.answerCallbackQuery();
    const kb = new InlineKeyboard()
      .text('← Назад', 'menu:back_user');

    await ctx.editMessageText(
      '*Справка*\n\n' +
      '*Быстрый старт:*\n' +
      '1\\. Нажмите "Кошельки" → "\\+ Добавить"\n' +
      '2\\. Вставьте адрес кошелька \\(0x\\.\\.\\.\\)\n' +
      '3\\. Выберите сеть — готово\\!\n\n' +
      'Бот мониторит транзакции и присылает алерты автоматически\\.',
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  });

  bot.command('delete', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    const client = await getClientByUserId(ctx.from?.id);
    if (!client) {
      await ctx.reply('Вы не зарегистрированы\\.');
      return;
    }

    const kb = new InlineKeyboard()
      .text('Да, удалить аккаунт', 'us:delete_confirm')
      .text('Отмена', 'us:delete_cancel');

    await ctx.reply(
      '*Удаление аккаунта*\n\n' +
      'Будут удалены:\n' +
      '— Все кошельки и мониторинг\n' +
      '— Настройки и политики\n\n' +
      'История транзакций будет сохранена анонимно\\.\n\n' +
      '*Это действие необратимо\\!*',
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  });

  bot.callbackQuery('us:delete_confirm', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const client = await getClientByUserId(userId);
    if (!client) {
      await ctx.editMessageText('Аккаунт не найден\\.');
      return;
    }

    try {
      await prisma.client.delete({ where: { id: client.id } });

      await audit({
        action: 'client.delete',
        actorId: userId,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: client.id,
        targetType: 'client',
        details: { selfDelete: true },
      });

      await ctx.editMessageText(
        'Аккаунт удалён\\.\n\n' +
        'Для повторной регистрации используйте /start',
        { parse_mode: 'MarkdownV2' }
      );

      logger.info({ userId, clientId: client.id }, 'User self-deleted account');
    } catch (error) {
      logger.error({ error, userId }, 'Failed to delete account');
      await ctx.editMessageText('Ошибка при удалении\\. Попробуйте позже\\.');
    }
  });

  bot.callbackQuery('us:delete_cancel', async (ctx) => {
    await ctx.answerCallbackQuery();
    await ctx.editMessageText('Удаление отменено\\. Ваш аккаунт в безопасности\\.');
  });
}

async function showPlanInfo(ctx: BotContext, client: { id: string; createdAt: Date }, edit: boolean): Promise<void> {
  const limits = getTierLimits();
  const walletCount = await prisma.wallet.count({
    where: { clientId: client.id, isActive: true },
  });

  const walletIds = (await prisma.wallet.findMany({
    where: { clientId: client.id, isActive: true },
    select: { id: true },
  })).map(w => w.id);
  const txCount7d = walletIds.length > 0 ? await prisma.transactionHistory.count({
    where: { walletId: { in: walletIds }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
  }) : 0;
  const pendingCount = walletIds.length > 0 ? await prisma.transactionHistory.count({
    where: { walletId: { in: walletIds }, status: 'pending' },
  }) : 0;

  const text =
    '*Статус*\n\n' +
    `Кошельков: ${walletCount}/${limits.maxWallets}\n` +
    `Транзакций за 7 дней: ${txCount7d}\n` +
    `Pending: ${pendingCount}\n\n` +
    'Мониторинг: активен';

  const kb = new InlineKeyboard().text('← Назад', 'menu:back_user');

  const method = edit ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
  await method(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
}

async function getClientByUserId(userId: number | undefined): Promise<{ id: string; createdAt: Date } | null> {
  if (!userId) return null;
  return prisma.client.findUnique({
    where: { telegramUserId: BigInt(userId) },
    select: { id: true, createdAt: true },
  });
}
