import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { setupClientsHandlers } from './clients.js';
import { setupWhitelistHandlers } from './whitelist.js';
import { setupStatsHandlers } from './stats.js';
import { setupNetworksHandlers } from './networks.js';
import { setupAllowedUsersHandlers } from './allowed-users.js';
import { setupGroupsHandlers } from './groups.js';
import { setupAdminWalletsHandlers } from './wallets.js';
import { setupManualAnalyzeHandlers } from './manual-analyze.js';
import { monitoringControl } from '../../monitoring-control.js';
import { config } from '../../../config/index.js';
import { prisma } from '../../../db/index.js';

export function setupAdminHandlers(bot: Bot<BotContext>): void {
  const adminOnly = async (ctx: BotContext, next: () => Promise<void>) => {
    const isAdmin = await checkIsAdmin(ctx.from?.id);
    if (!isAdmin) {
      if (ctx.chat?.type === 'private') {
        await ctx.reply('⛔ Эта команда доступна только администраторам\\.');
      }
      return;
    }
    return next();
  };

  bot.command('clients', adminOnly);
  bot.command('addclient', adminOnly);
  bot.command('addwallet', adminOnly);
  bot.command('whitelist', adminOnly);
  bot.command('stats', adminOnly);
  bot.command('networks', adminOnly);
  bot.command('allowed', adminOnly);
  bot.command('groups', adminOnly);
  bot.command('addgroup', adminOnly);
  bot.command('settings', adminOnly);

  bot.command('settings', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    await showSettings(ctx);
  });

  bot.callbackQuery(/^settings:/, async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }
    const action = ctx.callbackQuery.data.split(':')[1];
    if (action === 'toggle_monitoring') {
      const current = monitoringControl.getMode();
      if (current === 'off') {
        await monitoringControl.setMode('standby');
      } else {
        await monitoringControl.setMode('off');
      }
      await showSettings(ctx);
    }
    await ctx.answerCallbackQuery();
  });

  setupClientsHandlers(bot);
  setupWhitelistHandlers(bot);
  setupStatsHandlers(bot);
  setupNetworksHandlers(bot);
  setupAllowedUsersHandlers(bot);
  setupGroupsHandlers(bot);
  setupAdminWalletsHandlers(bot);
  setupManualAnalyzeHandlers(bot);
}

async function showSettings(ctx: BotContext): Promise<void> {
  const mode = monitoringControl.getMode();
  const modeEmoji = { off: '🔴', standby: '🟡', active: '🟢' }[mode];
  const modeLabel = { off: 'Выключен', standby: 'Ожидание', active: 'Активный' }[mode];

  const [clientCount, walletCount, networkCount] = await Promise.all([
    prisma.client.count(),
    prisma.wallet.count({ where: { isActive: true } }),
    prisma.network.count({ where: { isEnabled: true } }),
  ]);

  const lines = [
    '⚙️ *Настройки*',
    '',
    `${modeEmoji} Мониторинг: *${modeLabel}*`,
    `📊 Интервал: ${escapeMarkdown(String(monitoringControl.getIntervalMs() / 1000))}с`,
    `👥 Клиентов: ${clientCount}`,
    `👛 Кошельков: ${walletCount}`,
    `🌐 Сетей: ${networkCount}`,
    '',
    `Tenderly: ${config.tenderly.isConfigured ? '✅' : '❌'}`,
    `Gemini AI: ${config.ai.isConfigured ? '✅' : '❌'}`,
    `Etherscan: ${config.etherscan.isConfigured ? '✅' : '❌'}`,
    `Webhooks: ${config.webhook.enabled ? '✅' : '❌'}`,
  ];

  const keyboard = new InlineKeyboard()
    .text(mode === 'off' ? '🟢 Включить мониторинг' : '🔴 Выключить мониторинг', 'settings:toggle_monitoring');

  const method = 'editMessageText' in ctx ? 'editMessageText' : 'reply';
  try {
    if (method === 'editMessageText' && ctx.callbackQuery) {
      await ctx.editMessageText(lines.join('\n'), {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      });
    } else {
      await ctx.reply(lines.join('\n'), {
        parse_mode: 'MarkdownV2',
        reply_markup: keyboard,
      });
    }
  } catch {
    await ctx.reply(lines.join('\n'), {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  }
}
