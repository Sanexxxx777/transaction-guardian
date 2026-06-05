import { Bot, Context, session, SessionFlavor, InlineKeyboard } from 'grammy';
import { config } from '../../config/index.js';
import { prisma } from '../../db/index.js';
import { checkRateLimit } from '../../db/redis.js';
import { createLogger } from '../../utils/logger.js';
import { escapeMarkdown } from '../../utils/formatters.js';

import { setupAdminHandlers } from './admin/index.js';
import { startAddWalletDeepLink } from './admin/wallets.js';
import { setupClientHandlers } from './client/index.js';
import { setupRegistrationHandlers } from './registration.js';
import { setupUserWalletHandlers } from './user/wallets.js';
import { setupUserSettingsHandlers } from './user/settings.js';
import { setupUserHistoryHandlers } from './user/history.js';
import { setupUserApprovalsHandlers } from './user/approvals.js';
import { setupSimCommand } from './sim-command.js';
import { sendTransactionNotification, sendStatusNotification } from './notifications.js';
import { monitoringControl } from '../monitoring-control.js';

const logger = createLogger('telegram-bot');

interface AddClientData {
  name?: string;
}

interface AddWalletData {
  clientId?: string;
  address?: string;
  chainId?: number;
}

interface RegistrationData {
  address?: string;
  walletType?: string;
}

interface SessionData {
  step?: string;
  data?: AddClientData | AddWalletData | RegistrationData | Record<string, unknown>;
}

export type BotContext = Context & SessionFlavor<SessionData>;

let bot: Bot<BotContext> | null = null;
let botUsername: string | null = null;

export function getBotUsername(): string | null {
  return botUsername;
}

function escMd(text: string): string {
  return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
}

export async function startBot(): Promise<Bot<BotContext>> {
  if (bot) {
    logger.warn('Bot already running');
    return bot;
  }

  bot = new Bot<BotContext>(config.telegram.botToken);

  bot.use(
    session({
      initial: (): SessionData => ({}),
    })
  );

  bot.use(async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId) {
      const allowed = await checkRateLimit(`tg:${userId}`, 20, 60);
      if (!allowed) {
        logger.warn({ userId }, 'Rate limited user');
        await ctx.reply('Слишком много запросов. Подождите минуту.');
        return;
      }
    }
    return next();
  });

  bot.catch((err) => {
    logger.error({ error: err.error, ctx: err.ctx?.update }, 'Bot error');
  });

  setupAdminHandlers(bot);
  setupClientHandlers(bot);
  setupRegistrationHandlers(bot);
  setupUserWalletHandlers(bot);
  setupUserSettingsHandlers(bot);
  setupUserHistoryHandlers(bot);
  setupUserApprovalsHandlers(bot);
  setupSimCommand(bot);

  await bot.api.setMyCommands([
    { command: 'start', description: 'Главное меню' },
    { command: 'sim', description: 'Симуляция Safe-транзакции по ссылке' },
    { command: 'wallets', description: 'Управление кошельками' },
    { command: 'history', description: 'История транзакций' },
    { command: 'settings', description: 'Настройки' },
    { command: 'help', description: 'Справка' },
  ]);

  const adminStartText =
    '◉ *Transaction Guardian*\n\n' +
    'Мониторинг Safe\\-кошельков и анализ транзакций\\.\n' +
    'AI\\-оценка рисков, whitelist протоколов, алерты\\.';

  function adminKeyboard() {
    const isOn = monitoringControl.getMode() !== 'off';
    const monLabel = isOn ? '● Мониторинг: ВКЛ (10с)' : '○ Мониторинг: ВЫКЛ';

    const toggleAction = isOn ? 'mon:off' : 'mon:on';
    return new InlineKeyboard()
      .text(monLabel, toggleAction).row()
      .text('▸ Группы', 'grp:list').text('👛 Кошельки', 'aw:list').row()
      .text('◈ Whitelist', 'menu:whitelist').text('▸ Статистика', 'menu:stats').row()
      .text('› Справка', 'menu:help');
  }

  const clientStartText =
    '◉ *Transaction Guardian*\n\n' +
    'Мониторинг транзакций кошельков этой группы\\.';

  const clientStartKeyboard = new InlineKeyboard()
    .text('📜 История', 'menu:history').text('👛 Кошельки', 'menu:wallets').row()
    .text('› Справка', 'menu:help_client');

  bot.command('start', async (ctx) => {
    ctx.session.step = undefined;
    ctx.session.data = undefined;
    const chatType = ctx.chat?.type;

    const payload = ctx.match;
    if (chatType === 'private' && typeof payload === 'string' && payload.startsWith('aw_')) {
      const isAdmin = await checkIsAdmin(ctx.from?.id);
      if (isAdmin) {
        const address = payload.slice('aw_'.length);
        await startAddWalletDeepLink(ctx, address);
        return;
      }
    }

    if (chatType === 'private') {
      const isAdmin = await checkIsAdmin(ctx.from?.id);
      if (isAdmin) {
        await ctx.reply(adminStartText, {
          parse_mode: 'MarkdownV2',
          reply_markup: adminKeyboard(),
        });
      } else {
        await ctx.reply(
          '◉ *Transaction Guardian*\n\n' +
          'Бот для мониторинга транзакций кошельков\\.\n' +
          'AI\\-анализ рисков, симуляция, алерты\\.\n\n' +
          'Управление доступно только администраторам\\.\n' +
          'Уведомления приходят в группу, где находятся клиент и администратор\\.\n\n' +
          'Для подключения обратитесь к администратору\\.',
          { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
        );
      }
    } else {
      await ctx.reply(clientStartText, {
        parse_mode: 'MarkdownV2',
        reply_markup: clientStartKeyboard,
      });
    }
  });

  bot.command('help', async (ctx) => {
    const chatType = ctx.chat?.type;
    const isAdmin = chatType === 'private' && await checkIsAdmin(ctx.from?.id);

    if (isAdmin) {
      const text =
        '› *Справка администратора*\n\n' +
        '*Управление:*\n' +
        '  ▸ Группы — управление группами и кошельками\n\n' +
        '*Безопасность:*\n' +
        '  ◈ Whitelist — протоколы и адреса\n' +
        '  ◎ Сети — вкл/выкл мониторинг\n\n' +
        '*Мониторинг:*\n' +
        '  ▸ Статистика — 7\\-дневная сводка\n\n' +
        '*Алерты:*\n' +
        '  Автоматически при pending\\-транзакциях\n' +
        '  AI\\-анализ рисков \\+ рекомендации';
      const kb = new InlineKeyboard().text('← Назад', 'menu:back_admin');
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
    } else {
      const text =
        '› *Справка*\n\n' +
        '  ▸ История — последние транзакции\n' +
        '  ◈ Кошельки — отслеживаемые адреса\n' +
        '  ◎ Безопасность — лимиты и политики\n\n' +
        'Бот уведомляет о pending\\-транзакциях автоматически\\.';
      const kb = new InlineKeyboard().text('← Назад', 'menu:back_client');
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
    }
  });

  bot.callbackQuery(/^menu:/, async (ctx) => {
    const action = ctx.callbackQuery.data.replace('menu:', '');
    await ctx.answerCallbackQuery();
    const backAdmin = new InlineKeyboard().text('← Назад', 'menu:back_admin');
    const backClient = new InlineKeyboard().text('← Назад', 'menu:back_client');

    try {
      switch (action) {
        case 'monitoring_mode': {
          await ctx.editMessageText(adminStartText, {
            parse_mode: 'MarkdownV2',
            reply_markup: adminKeyboard(),
          });
          break;
        }

        case 'back_admin': {
          await ctx.editMessageText(adminStartText, {
            parse_mode: 'MarkdownV2',
            reply_markup: adminKeyboard(),
          });
          break;
        }

        case 'whitelist': {
          const [protoCount, addrCount] = await Promise.all([
            prisma.protocolWhitelist.count({ where: { clientId: null, isActive: true } }),
            prisma.addressWhitelist.count({ where: { clientId: null, isActive: true } }),
          ]);
          const wlKb = new InlineKeyboard()
            .text(`📋 Протоколы (${protoCount})`, 'wl:protos').row()
            .text(`📍 Адреса (${addrCount})`, 'wl:addrs').row()
            .text('← Назад', 'menu:back_admin');
          await ctx.editMessageText(
            '✅ *Глобальный Whitelist*\n\nПрименяется ко всем клиентам',
            { parse_mode: 'MarkdownV2', reply_markup: wlKb }
          );
          break;
        }

        case 'stats': {
          const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
          const [clientsCount, walletsCount, totalTx, pendingTx, riskBreakdown, tierBreakdown] = await Promise.all([
            prisma.client.count(),
            prisma.wallet.count({ where: { isActive: true } }),
            prisma.transactionHistory.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
            prisma.transactionHistory.count({ where: { status: 'pending' } }),
            prisma.transactionHistory.groupBy({
              by: ['riskLevel'],
              where: { createdAt: { gte: sevenDaysAgo } },
              _count: true,
            }),
            prisma.client.groupBy({
              by: ['tier'],
              _count: true,
            }),
          ]);

          const riskMap = Object.fromEntries(riskBreakdown.map(r => [r.riskLevel || 'unknown', r._count]));
          const totalClients = tierBreakdown.reduce((sum, t) => sum + t._count, 0);

          await ctx.editMessageText(
            `▸ *Статистика*\n\n` +
            `*Пользователи:*\n` +
            `├ Всего: *${totalClients}*\n` +
            `└ Кошельков: *${walletsCount}*\n\n` +
            `*Транзакции \\(7д\\):*\n` +
            `├ Всего: *${totalTx}* / Pending: *${pendingTx}*\n` +
            `├ OK: *${riskMap['ok'] || 0}* / Warning: *${riskMap['warning'] || 0}*\n` +
            `└ Danger: *${riskMap['danger'] || 0}*`,
            { parse_mode: 'MarkdownV2', reply_markup: backAdmin }
          );
          break;
        }

        case 'networks': {
          const networks = await prisma.network.findMany({ orderBy: { name: 'asc' } });
          const lines = networks.map((n, i) => {
            const icon = n.isEnabled ? '●' : '○';
            const end = i === networks.length - 1 ? '└' : '├';
            return `  ${end} ${icon} ${escMd(n.name)}`;
          });
          await ctx.editMessageText(
            `◎ *Сети*\n\n${lines.join('\n')}\n\nУправление: /networks`,
            { parse_mode: 'MarkdownV2', reply_markup: backAdmin }
          );
          break;
        }

        case 'allowed': {
          const allowedUsers = await prisma.allowedUser.findMany({ orderBy: { createdAt: 'desc' } });
          const regOpen = process.env.REGISTRATION_OPEN !== 'false';
          const kb = new InlineKeyboard()
            .text('➕ Добавить', 'allowed:add').row()
            .text('← Назад', 'menu:back_admin');
          let allowedText = `👥 *Допуски к регистрации*\n\n`;
          allowedText += regOpen
            ? `🔓 Режим: *открытая регистрация*\n`
            : `🔒 Режим: *только по списку*\n`;
          allowedText += `Записей: *${allowedUsers.length}*\n\n`;
          allowedText += `Подробнее: /allowed`;
          await ctx.editMessageText(allowedText, { parse_mode: 'MarkdownV2', reply_markup: kb });
          break;
        }

        case 'help': {
          await ctx.editMessageText(
            '› *Справка администратора*\n\n' +
            '*Управление:*\n' +
            '  ▸ Клиенты — список, кошельки, политики\n' +
            '  ▷ Добавить — новый клиент \\+ кошельки\n\n' +
            '*Безопасность:*\n' +
            '  ◈ Whitelist — протоколы и адреса\n\n' +
            '*Мониторинг:*\n' +
            '  ▸ Статистика — 7\\-дневная сводка\n\n' +
            '*Алерты:*\n' +
            '  Автоматически при pending\\-транзакциях\n' +
            '  AI\\-анализ рисков \\+ рекомендации',
            { parse_mode: 'MarkdownV2', reply_markup: backAdmin }
          );
          break;
        }

        case 'user_history': {
          const userId = ctx.from?.id;
          if (!userId) break;
          const userClient = await prisma.client.findUnique({
            where: { telegramUserId: BigInt(userId) },
            select: { id: true },
          });
          if (!userClient) {
            await ctx.editMessageText('Вы не зарегистрированы\\. Используйте /start', { parse_mode: 'MarkdownV2' });
            break;
          }
          const walletIds = (await prisma.wallet.findMany({
            where: { clientId: userClient.id, isActive: true },
            select: { id: true },
          })).map(w => w.id);
          const recentCount = await prisma.transactionHistory.count({
            where: { walletId: { in: walletIds }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
          });
          const pendingCount = await prisma.transactionHistory.count({
            where: { walletId: { in: walletIds }, status: 'pending' },
          });
          const userBackKb = new InlineKeyboard()
            .text('Полный список', `uh:${userClient.id}:0`).row()
            .text('← Назад', 'menu:back_user');
          await ctx.editMessageText(
            `*История транзакций*\n\n` +
            `За 7 дней: *${recentCount}*\n` +
            `Pending: *${pendingCount}*`,
            { parse_mode: 'MarkdownV2', reply_markup: userBackKb }
          );
          break;
        }

        case 'user_wallets': {
          const userId = ctx.from?.id;
          if (!userId) break;
          const uwClient = await prisma.client.findUnique({
            where: { telegramUserId: BigInt(userId) },
          });
          const uwIsAdmin = await checkIsAdmin(userId);

          let uwWallets: Array<{ id: string; address: string; chainId: number; type: string }>;
          if (uwClient) {
            uwWallets = await prisma.wallet.findMany({
              where: { clientId: uwClient.id, isActive: true },
              orderBy: { createdAt: 'desc' },
            });
          } else if (uwIsAdmin) {
            uwWallets = await prisma.wallet.findMany({
              where: { isActive: true },
              orderBy: { createdAt: 'desc' },
            });
          } else {
            await ctx.editMessageText('Вы не зарегистрированы\\. Используйте /start', { parse_mode: 'MarkdownV2' });
            break;
          }
          let uwText = `*Кошельки \\(${uwWallets.length}\\)*\n\n`;
          if (uwWallets.length === 0) {
            uwText += '_Нет кошельков\\._\n';
          } else {
            for (const w of uwWallets) {
              const net = (await prisma.network.findUnique({ where: { chainId: w.chainId } }))?.shortName || '?';
              uwText += `\`${w.address}\` ${escapeMarkdown(net)} ${w.type === 'safe' ? 'Safe' : 'EOA'}\n`;
            }
          }
          const uwKb = new InlineKeyboard();
          for (const w of uwWallets) {
            const shortAddr = `${w.address.slice(0, 6)}...${w.address.slice(-4)}`;
            uwKb.text(`x ${shortAddr}`, `uw:rm:${w.id}`).row();
          }
          uwKb.text('+ Добавить', 'uw:add').row();
          uwKb.text('← Назад', 'menu:back_user');
          await ctx.editMessageText(uwText, { parse_mode: 'MarkdownV2', reply_markup: uwKb });
          break;
        }

        case 'user_help': {
          const uhKb = new InlineKeyboard().text('← Назад', 'menu:back_user');
          await ctx.editMessageText(
            '*Справка*\n\n' +
            'Бот мониторит транзакции в ваших кошельках и присылает уведомления\\.\n\n' +
            '*Кошельки* — добавить/удалить кошельки\n' +
            '*История* — последние транзакции\n' +
            '*Статус* — сводка по аккаунту\n\n' +
            'Уведомления приходят автоматически при pending\\-транзакциях\\.',
            { parse_mode: 'MarkdownV2', reply_markup: uhKb }
          );
          break;
        }

        case 'user_plan': {
          const userId = ctx.from?.id;
          if (!userId) break;
          const upClient = await prisma.client.findUnique({
            where: { telegramUserId: BigInt(userId) },
          });
          const upIsAdmin = await checkIsAdmin(userId);
          if (!upClient && !upIsAdmin) {
            await ctx.editMessageText('Вы не зарегистрированы\\. Используйте /start', { parse_mode: 'MarkdownV2' });
            break;
          }
          const upWalletFilter = upClient ? { clientId: upClient.id, isActive: true as const } : { isActive: true as const };
          const upWallets = await prisma.wallet.findMany({
            where: upWalletFilter,
            select: { id: true },
          });
          const upTxCount = await prisma.transactionHistory.count({
            where: { walletId: { in: upWallets.map(w => w.id) }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
          });
          const upPending = await prisma.transactionHistory.count({
            where: { walletId: { in: upWallets.map(w => w.id) }, status: 'pending' },
          });
          const upKb = new InlineKeyboard().text('← Назад', 'menu:back_user');
          await ctx.editMessageText(
            `*Статус*\n\n` +
            `Кошельков: *${upWallets.length}*\n` +
            `Транзакций за 7 дней: *${upTxCount}*\n` +
            `Pending: *${upPending}*\n\n` +
            `Мониторинг: активен`,
            { parse_mode: 'MarkdownV2', reply_markup: upKb }
          );
          break;
        }

        case 'back_client': {
          await ctx.editMessageText(clientStartText, {
            parse_mode: 'MarkdownV2',
            reply_markup: clientStartKeyboard,
          });
          break;
        }

        case 'back_user': {
          ctx.session.step = undefined;
          ctx.session.data = undefined;
          const userId = ctx.from?.id;
          if (!userId) break;
          const userClient = await prisma.client.findUnique({
            where: { telegramUserId: BigInt(userId) },
          });
          const userKb = new InlineKeyboard()
            .text('Кошельки', 'menu:user_wallets').text('Статус', 'menu:user_plan').row()
            .text('История', 'menu:user_history').text('Справка', 'menu:user_help');
          await ctx.editMessageText(
            '◉ *Transaction Guardian*\n\n' +
            (userClient ? `Привет, *${escapeMarkdown(userClient.name)}*\\!\n` : '') +
            'Мониторинг ваших кошельков активен\\.',
            { parse_mode: 'MarkdownV2', reply_markup: userKb }
          );
          break;
        }

        case 'history': {
          const chatId = ctx.chat?.id;
          if (!chatId) break;
          const client = await prisma.client.findUnique({
            where: { telegramChatId: BigInt(chatId) },
          });
          if (!client) {
            await ctx.editMessageText(
              '○ Этот чат не привязан к клиенту\\.',
              { parse_mode: 'MarkdownV2', reply_markup: backClient }
            );
            break;
          }
          const walletIds = (await prisma.wallet.findMany({
            where: { clientId: client.id },
            select: { id: true },
          })).map(w => w.id);
          const recent = await prisma.transactionHistory.count({
            where: { walletId: { in: walletIds }, createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
          });
          const pending = await prisma.transactionHistory.count({
            where: { walletId: { in: walletIds }, status: 'pending' },
          });
          await ctx.editMessageText(
            `▸ *История транзакций*\n\n` +
            `├ За 7 дней: *${recent}*\n` +
            `└ Pending: *${pending}*\n\n` +
            `Полный список: /history`,
            { parse_mode: 'MarkdownV2', reply_markup: backClient }
          );
          break;
        }

        case 'wallets': {
          const chatId = ctx.chat?.id;
          if (!chatId) break;
          const client = await prisma.client.findUnique({
            where: { telegramChatId: BigInt(chatId) },
            include: { wallets: { where: { isActive: true } } },
          });
          if (!client) {
            await ctx.editMessageText(
              '○ Этот чат не привязан к клиенту\\.',
              { parse_mode: 'MarkdownV2', reply_markup: backClient }
            );
            break;
          }
          const count = client.wallets.length;
          const addrs = [...new Set(client.wallets.map(w => w.address))];
          const lines = addrs.slice(0, 5).map((a, i) => {
            const short = `${a.slice(0, 6)}\\.\\.${a.slice(-4)}`;
            const end = i === Math.min(addrs.length, 5) - 1 ? '└' : '├';
            return `  ${end} \`${short}\``;
          });
          await ctx.editMessageText(
            `◈ *Кошельки \\(${count}\\)*\n\n${lines.join('\n')}\n\nДетали: /wallets`,
            { parse_mode: 'MarkdownV2', reply_markup: backClient }
          );
          break;
        }

        case 'policy': {
          const chatId = ctx.chat?.id;
          if (!chatId) break;
          const client = await prisma.client.findUnique({
            where: { telegramChatId: BigInt(chatId) },
            include: { policy: true },
          });
          if (!client || !client.policy) {
            await ctx.editMessageText(
              '○ Политика не настроена\\.',
              { parse_mode: 'MarkdownV2', reply_markup: backClient }
            );
            break;
          }
          const p = client.policy;
          await ctx.editMessageText(
            `◎ *Безопасность*\n\n` +
            `├ Макс\\. транзакция: *$${Number(p.maxTransactionUsd || 0).toLocaleString()}*\n` +
            `├ Дневной лимит: *$${Number(p.dailyLimitUsd || 0).toLocaleString()}*\n` +
            `└ Блок безлимитных approve: *${p.blockUnlimitedApprovals ? 'Да' : 'Нет'}*\n\n` +
            `Детали: /policy`,
            { parse_mode: 'MarkdownV2', reply_markup: backClient }
          );
          break;
        }

        case 'help_client': {
          await ctx.editMessageText(
            '› *Справка*\n\n' +
            '  ▸ История — последние транзакции\n' +
            '  ◈ Кошельки — отслеживаемые адреса\n' +
            '  ◎ Безопасность — лимиты и политики\n\n' +
            'Бот уведомляет о pending\\-транзакциях автоматически\\.',
            { parse_mode: 'MarkdownV2', reply_markup: backClient }
          );
          break;
        }
      }
    } catch (err) {
      logger.error({ error: err, action }, 'Menu callback error');
    }
  });

  bot.callbackQuery(/^mon:/, async (ctx) => {
    const action = ctx.callbackQuery.data.replace('mon:', '');
    await ctx.answerCallbackQuery();

    try {
      if (action === 'on') {
        await monitoringControl.setMode('active');
        await ctx.editMessageText(
          `◉ *Transaction Guardian*\n\n` +
          `● Мониторинг: *ВКЛ* \\(опрос каждые 10с\\)`,
          { parse_mode: 'MarkdownV2', reply_markup: adminKeyboard() }
        );
      } else {
        await monitoringControl.setMode('off');
        await ctx.editMessageText(
          `◉ *Transaction Guardian*\n\n` +
          `○ Мониторинг: *ВЫКЛ*`,
          { parse_mode: 'MarkdownV2', reply_markup: adminKeyboard() }
        );
      }
    } catch (err) {
      logger.error({ error: err, action }, 'Monitoring toggle callback error');
    }
  });

  try {
    const me = await bot.api.getMe();
    botUsername = me.username || null;
    logger.info({ username: botUsername }, 'Bot identity resolved');
  } catch (err) {
    logger.warn({ err }, 'Failed to resolve bot @username — deep-links will be disabled');
  }

  bot.start({
    onStart: () => {
      logger.info('Telegram bot polling started');
    },
  });

  return bot;
}

export async function stopBot(): Promise<void> {
  if (bot) {
    await bot.stop();
    bot = null;
    logger.info('Telegram bot stopped');
  }
}

export function getBot(): Bot<BotContext> | null {
  return bot;
}

export async function checkIsAdmin(userId: number | undefined): Promise<boolean> {
  if (!userId) return false;

  if (config.telegram.adminUserId && userId === config.telegram.adminUserId) {
    return true;
  }

  const admin = await prisma.admin.findUnique({
    where: { telegramUserId: BigInt(userId) },
  });

  return admin !== null;
}

export async function getClientByChatId(chatId: number): Promise<{
  id: string;
  name: string;
} | null> {
  const client = await prisma.client.findUnique({
    where: { telegramChatId: BigInt(chatId) },
    select: { id: true, name: true },
  });

  return client;
}

export { sendTransactionNotification, sendStatusNotification };
