import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';
import type { BotContext } from './index.js';
import { prisma } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { escapeMarkdown } from '../../utils/formatters.js';
import { validate, ethereumAddressSchema } from '../../utils/validators.js';
import { audit } from '../audit-log/index.js';
import type { WalletType } from '../../models/transaction.js';

const logger = createLogger('registration');

const REGISTRATION_NETWORKS = [
  { chainId: 1, name: 'Ethereum', shortName: 'ETH' },
  { chainId: 42161, name: 'Arbitrum', shortName: 'ARB' },
  { chainId: 8453, name: 'Base', shortName: 'BASE' },
  { chainId: 137, name: 'Polygon', shortName: 'MATIC' },
  { chainId: 10, name: 'Optimism', shortName: 'OP' },
];

export function setupRegistrationHandlers(bot: Bot<BotContext>): void {
  bot.callbackQuery('reg:start', async (ctx) => {
    await ctx.answerCallbackQuery();
    const userId = ctx.from?.id;
    if (!userId) return;

    const existing = await prisma.client.findUnique({
      where: { telegramUserId: BigInt(userId) },
    });

    if (existing) {
      await ctx.editMessageText(
        '👋 Вы уже зарегистрированы\\!\n\n' +
        'Используйте /wallets для управления кошельками\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    if (process.env.REGISTRATION_OPEN === 'false') {
      const isAllowed = await prisma.allowedUser.findUnique({
        where: { telegramUserId: BigInt(userId) },
      });
      if (!isAllowed) {
        await ctx.editMessageText(
          '🔒 *Регистрация по приглашению*\n\n' +
          'Доступ ограничен\\. Обратитесь к администратору для получения доступа\\.',
          { parse_mode: 'MarkdownV2' }
        );
        return;
      }
    }

    ctx.session.step = 'reg:address';
    await ctx.editMessageText(
      '📝 *Регистрация*\n\n' +
      'Введите адрес кошелька для мониторинга:\n\n' +
      '_Поддерживаются Safe \\(мультисиг\\) и обычные \\(EOA\\) кошельки_',
      { parse_mode: 'MarkdownV2' }
    );
  });

  bot.callbackQuery(/^reg:chain:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const chainId = parseInt(ctx.callbackQuery.data.replace('reg:chain:', ''));
    const userId = ctx.from?.id;
    if (!userId) return;

    const address = (ctx.session.data as { address?: string })?.address;
    const walletType = (ctx.session.data as { walletType?: WalletType })?.walletType;

    if (!address || !walletType) {
      await ctx.editMessageText('❌ Ошибка регистрации\\. Попробуйте /start');
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return;
    }

    try {
      const client = await prisma.client.create({
        data: {
          name: ctx.from?.first_name || `User ${userId}`,
          telegramChatId: BigInt(ctx.chat!.id),
          telegramUserId: BigInt(userId),
          tier: 'free',
          isSelfRegistered: true,
        },
      });

      await prisma.policy.create({
        data: { clientId: client.id },
      });

      await prisma.wallet.create({
        data: {
          clientId: client.id,
          address,
          chainId,
          type: walletType,
          name: `${walletType === 'safe' ? 'Safe' : 'EOA'} ${address.slice(0, 8)}...`,
        },
      });

      await audit({
        action: 'client.create',
        actorId: userId,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: client.id,
        targetType: 'client',
        details: { address, chainId, walletType, selfRegistered: true },
      });

      ctx.session.step = undefined;
      ctx.session.data = undefined;

      const network = REGISTRATION_NETWORKS.find(n => n.chainId === chainId);
      const doneKb = new InlineKeyboard()
        .text('Кошельки', 'menu:user_wallets').text('История', 'menu:user_history').row()
        .text('Статус', 'menu:user_plan').text('Главное меню', 'menu:back_user');

      await ctx.editMessageText(
        '*Регистрация завершена\\!*\n\n' +
        `Кошелёк: \`${escapeMarkdown(address)}\`\n` +
        `Сеть: ${escapeMarkdown(network?.name || 'Unknown')}\n` +
        `Тип: ${walletType === 'safe' ? 'Safe \\(мультисиг\\)' : 'EOA'}\n\n` +
        'Мониторинг запущен\\. Вы будете получать уведомления о транзакциях\\.',
        { parse_mode: 'MarkdownV2', reply_markup: doneKb }
      );

      logger.info({ userId, clientId: client.id, address, chainId, walletType }, 'User self-registered');
    } catch (error) {
      logger.error({ error, userId }, 'Registration failed');
      await ctx.editMessageText('❌ Ошибка регистрации\\. Попробуйте позже\\.');
      ctx.session.step = undefined;
      ctx.session.data = undefined;
    }
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.session.step !== 'reg:address') {
      return next();
    }

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return next();
    }
    const result = validate(ethereumAddressSchema, text);
    if (!result.success) {
      await ctx.reply(
        `❌ ${escapeMarkdown(result.error)}\n\nВведите адрес в формате 0x\\.\\.\\.`,
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const address = result.data;

    const walletType = await detectWalletType(address);

    ctx.session.data = { address, walletType };
    ctx.session.step = 'reg:chain';

    const kb = new InlineKeyboard();
    for (let i = 0; i < REGISTRATION_NETWORKS.length; i++) {
      const n = REGISTRATION_NETWORKS[i];
      kb.text(n.shortName, `reg:chain:${n.chainId}`);
      if ((i + 1) % 3 === 0) kb.row();
    }

    const typeLabel = walletType === 'safe' ? 'Safe (мультисиг)' : 'EOA (обычный)';
    await ctx.reply(
      `👛 Кошелёк: \`${escapeMarkdown(address.slice(0, 10))}\\.\\.\\.\`\n` +
      `📋 Тип: ${escapeMarkdown(typeLabel)}\n\n` +
      'Выберите сеть:',
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  });
}

async function detectWalletType(address: string): Promise<WalletType> {
  try {
    const response = await axios.get(
      `https://api.safe.global/tx-service/eth/api/v1/safes/${address}/`,
      { timeout: 5000 }
    );
    if (response.status === 200) {
      return 'safe';
    }
  } catch {
  }
  return 'eoa';
}
