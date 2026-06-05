import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown, formatAddress } from '../../../utils/formatters.js';
import { audit } from '../../audit-log/index.js';
import { validate, clientNameSchema, chatIdSchema, ethereumAddressSchema, chainIdSchema } from '../../../utils/validators.js';
import type { WalletType } from '../../../models/transaction.js';

const CALLBACK_PREFIX = 'admin_client';

export function setupClientsHandlers(bot: Bot<BotContext>): void {
  bot.command('clients', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;

    const clients = await prisma.client.findMany({
      include: {
        _count: { select: { wallets: true } },
      },
      orderBy: { name: 'asc' },
    });

    if (clients.length === 0) {
      await ctx.reply(
        '📋 *Клиенты*\n\nКлиентов пока нет\\.\n\nИспользуйте /addclient для добавления\\.',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const client of clients) {
      keyboard.text(
        `${client.name} (${client._count.wallets})`,
        `${CALLBACK_PREFIX}:view:${client.id}`
      ).row();
    }
    keyboard.text('➕ Добавить клиента', `${CALLBACK_PREFIX}:add`);

    await ctx.reply(`📋 *Клиенты* \\(${clients.length}\\)`, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  });

  bot.command('addclient', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;

    ctx.session.step = 'addclient:name';
    const cancelKb = new InlineKeyboard().text('← Отмена', 'menu:back_admin');
    await ctx.reply(
      '➕ *Добавление клиента*\n\n' +
      'Введите имя клиента:',
      { parse_mode: 'MarkdownV2', reply_markup: cancelKb }
    );
  });

  bot.command('addwallet', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;

    const clients = await prisma.client.findMany({ orderBy: { name: 'asc' } });
    if (clients.length === 0) {
      await ctx.reply('Нет клиентов\\. Сначала /addclient', { parse_mode: 'MarkdownV2' });
      return;
    }

    const keyboard = new InlineKeyboard();
    for (const client of clients) {
      keyboard.text(client.name, `${CALLBACK_PREFIX}:addwallet:${client.id}`).row();
    }
    keyboard.text('← Отмена', 'menu:back_admin');

    await ctx.reply('➕ *Добавить кошелёк*\n\nВыберите клиента:', {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });
  });

  bot.callbackQuery(new RegExp(`^${CALLBACK_PREFIX}:`), async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }

    const data = ctx.callbackQuery.data;
    const [, action, ...params] = data.split(':');

    switch (action) {
      case 'view':
        await handleViewClient(ctx, params[0]);
        break;
      case 'wallets':
        await handleViewWallets(ctx, params[0]);
        break;
      case 'policy':
        await handleViewPolicy(ctx, params[0]);
        break;
      case 'addwallet':
        await handleAddWalletStart(ctx, params[0]);
        break;
      case 'rmwallet':
        await handleRemoveWalletConfirm(ctx, params[0], params[1]);
        break;
      case 'rmwallet_ok':
        await handleRemoveWallet(ctx, params[0], params[1]);
        break;
      case 'delete':
        await handleDeleteConfirm(ctx, params[0]);
        break;
      case 'delete_confirm':
        await handleDeleteClient(ctx, params[0]);
        break;
      case 'toggle_approvals':
        await handleToggleApprovals(ctx, params[0]);
        break;
      case 'toggle_unknown':
        await handleToggleUnknown(ctx, params[0]);
        break;
      case 'set_txlimit':
        await handleSetTxLimitStart(ctx, params[0]);
        break;
      case 'set_dailylimit':
        await handleSetDailyLimitStart(ctx, params[0]);
        break;
      case 'clear_txlimit':
        await handleClearLimit(ctx, params[0], 'maxTransactionUsd');
        break;
      case 'clear_dailylimit':
        await handleClearLimit(ctx, params[0], 'dailyLimitUsd');
        break;
      case 'back':
        await handleBackToClients(ctx);
        break;
      case 'add': {
        ctx.session.step = 'addclient:name';
        const addCancelKb = new InlineKeyboard().text('← Отмена', `${CALLBACK_PREFIX}:back`);
        await ctx.editMessageText(
          '➕ *Добавление клиента*\n\n' +
          'Введите имя клиента:',
          { parse_mode: 'MarkdownV2', reply_markup: addCancelKb }
        );
        break;
      }
    }

    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();

    const step = ctx.session.step;
    if (!step?.startsWith('addclient:') && !step?.startsWith('addwallet:') && !step?.startsWith('policy_')) {
      return next();
    }

    const text = ctx.message.text;
    if (text.startsWith('/')) {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return next();
    }

    if (step === 'addclient:name') {
      const nameResult = validate(clientNameSchema, text);
      if (!nameResult.success) {
        await ctx.reply(`❌ ${escapeMarkdown(nameResult.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }
      ctx.session.data = { name: nameResult.data };
      ctx.session.step = 'addclient:chatid';
      const chatIdCancelKb = new InlineKeyboard().text('← Отмена', 'menu:back_admin');
      await ctx.reply(
        `Имя: *${escapeMarkdown(nameResult.data)}*\n\n` +
        'Теперь введите ID чата клиента:\n' +
        '_\\(или свой Telegram ID для личных уведомлений\\)_',
        { parse_mode: 'MarkdownV2', reply_markup: chatIdCancelKb }
      );
    } else if (step === 'addclient:chatid') {
      const chatIdResult = validate(chatIdSchema, text);
      if (!chatIdResult.success) {
        await ctx.reply(`❌ ${escapeMarkdown(chatIdResult.error)}`);
        return;
      }
      const chatId = chatIdResult.data;

      try {
        const client = await prisma.client.create({
          data: {
            name: (ctx.session.data as { name?: string })?.name as string,
            telegramChatId: BigInt(chatId),
          },
        });

        await prisma.policy.create({
          data: { clientId: client.id },
        });

        await audit({
          action: 'client.create',
          actorId: ctx.from?.id,
          actorName: ctx.from?.username || ctx.from?.first_name,
          targetId: client.id,
          targetType: 'client',
          details: { name: client.name, chatId },
        });

        ctx.session.step = undefined;
        ctx.session.data = undefined;

        const successKb = new InlineKeyboard()
          .text('💼 Кошельки', `${CALLBACK_PREFIX}:wallets:${client.id}`)
          .text('➕ Кошелёк', `${CALLBACK_PREFIX}:addwallet:${client.id}`)
          .row()
          .text('← Главное меню', 'menu:back_admin');

        await ctx.reply(
          `✅ Клиент *${escapeMarkdown(client.name)}* создан\\!`,
          { parse_mode: 'MarkdownV2', reply_markup: successKb }
        );
      } catch (error) {
        ctx.session.step = undefined;
        ctx.session.data = undefined;
        await ctx.reply('❌ Ошибка создания клиента\\. Возможно, чат уже привязан\\.');
      }
    } else if (step?.startsWith('policy_txlimit:') || step?.startsWith('policy_dailylimit:')) {
      const [prefix, clientId] = step.split(':').slice(0, 2);
      const prefixFull = step.split(':')[0];
      const amount = parseFloat(text.replace(/[,$\s]/g, ''));
      if (isNaN(amount) || amount <= 0) {
        await ctx.reply('❌ Введите положительное число');
        return;
      }
      const field = prefixFull === 'policy_txlimit' ? 'maxTransactionUsd' : 'dailyLimitUsd';
      await prisma.policy.update({
        where: { clientId },
        data: { [field]: amount },
      });
      await audit({
        action: 'policy.update',
        actorId: ctx.from?.id,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: clientId,
        targetType: 'policy',
        details: { field, value: amount },
      });
      ctx.session.step = undefined;
      await ctx.reply(`✅ Лимит установлен: $${amount.toLocaleString()}`);
    } else if (step?.startsWith('addwallet:')) {
      const [, , clientId] = step.split(':');
      const parts = text.split(' ');
      const addressResult = validate(ethereumAddressSchema, parts[0]);
      if (!addressResult.success) {
        await ctx.reply(`❌ ${escapeMarkdown(addressResult.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }
      const address = addressResult.data;
      const chainIdResult = validate(chainIdSchema, parts[1] || '1');
      const chainId = chainIdResult.success ? chainIdResult.data : 1;

      try {
        const walletType = await detectWalletType(address, chainId);

        const wallet = await prisma.wallet.create({
          data: {
            clientId,
            address,
            chainId,
            type: walletType,
            name: `${walletType === 'safe' ? 'Safe' : 'EOA'} ${address.slice(0, 8)}...`,
          },
        });

        await audit({
          action: 'wallet.add',
          actorId: ctx.from?.id,
          actorName: ctx.from?.username || ctx.from?.first_name,
          targetId: wallet.id,
          targetType: 'wallet',
          details: { clientId, address, chainId },
        });

        ctx.session.step = undefined;

        const walletSuccessKb = new InlineKeyboard()
          .text('➕ Ещё кошелёк', `${CALLBACK_PREFIX}:addwallet:${clientId}`)
          .text('← Клиент', `${CALLBACK_PREFIX}:view:${clientId}`)
          .row()
          .text('← Главное меню', 'menu:back_admin');

        await ctx.reply(
          `✅ Кошелёк добавлен\\!\n\n` +
          `Адрес: \`${escapeMarkdown(address)}\`\n` +
          `Chain ID: ${chainId}`,
          { parse_mode: 'MarkdownV2', reply_markup: walletSuccessKb }
        );
      } catch (error) {
        await ctx.reply('❌ Ошибка добавления кошелька\\. Возможно, он уже существует\\.');
      }
    }
  });

  bot.command('chatid', async (ctx) => {
    await ctx.reply(`Chat ID: \`${ctx.chat?.id}\``, { parse_mode: 'MarkdownV2' });
  });
}

async function handleViewClient(ctx: BotContext, clientId: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: {
      wallets: true,
      _count: { select: { wallets: true } },
    },
  });

  if (!client) {
    await ctx.answerCallbackQuery('Клиент не найден');
    return;
  }

  const keyboard = new InlineKeyboard()
    .text('💼 Кошельки', `${CALLBACK_PREFIX}:wallets:${clientId}`)
    .text('➕ Кошелёк', `${CALLBACK_PREFIX}:addwallet:${clientId}`)
    .row()
    .text('⚙️ Политика', `${CALLBACK_PREFIX}:policy:${clientId}`)
    .text('📜 История', `${CALLBACK_PREFIX}:history:${clientId}`)
    .row()
    .text('🗑 Удалить клиента', `${CALLBACK_PREFIX}:delete:${clientId}`)
    .row()
    .text('← Назад', `${CALLBACK_PREFIX}:back`);

  await ctx.editMessageText(
    `👤 *${escapeMarkdown(client.name)}*\n\n` +
    `Кошельков: ${client._count.wallets}\n` +
    `Чат: \`${client.telegramChatId.toString()}\``,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    }
  );
}

async function handleViewWallets(ctx: BotContext, clientId: string): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { clientId },
    include: {
      _count: { select: { transactions: true } },
    },
  });

  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true },
  });

  let text = `💼 *Кошельки: ${escapeMarkdown(client?.name || '')}*\n\n`;

  if (wallets.length === 0) {
    text += 'Кошельков пока нет\\.';
  } else {
    for (const wallet of wallets) {
      const status = wallet.isActive ? '●' : '○';
      text += `${status} \`${escapeMarkdown(formatAddress(wallet.address))}\`\n`;
      text += `   Chain: ${wallet.chainId}`;
      if (wallet.name) text += ` \\| ${escapeMarkdown(wallet.name)}`;
      text += `\n`;
    }
  }

  const keyboard = new InlineKeyboard();

  const activeWallets = wallets.filter(w => w.isActive);
  for (const w of activeWallets.slice(0, 5)) {
    keyboard.text(`❌ ${formatAddress(w.address)}`, `${CALLBACK_PREFIX}:rmwallet:${w.id}:${clientId}`).row();
  }
  keyboard.text('➕ Добавить кошелёк', `${CALLBACK_PREFIX}:addwallet:${clientId}`).row();
  keyboard.text('← Назад', `${CALLBACK_PREFIX}:view:${clientId}`);

  await ctx.editMessageText(text, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
}

async function handleViewPolicy(ctx: BotContext, clientId: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    include: { policy: true },
  });

  if (!client) return;

  const policy = client.policy;
  const maxTx = policy?.maxTransactionUsd ? `$${policy.maxTransactionUsd.toString()}` : 'не задан';
  const dailyLimit = policy?.dailyLimitUsd ? `$${policy.dailyLimitUsd.toString()}` : 'не задан';
  const unlimited = policy?.blockUnlimitedApprovals ? '🚫 Заблокированы' : '⚠️ Разрешены';
  const unknown = policy?.blockUnknownContracts ? '🚫 Заблокированы' : '⚠️ Разрешены';

  const keyboard = new InlineKeyboard()
    .text(`📝 Лимит tx: ${maxTx}`, `${CALLBACK_PREFIX}:set_txlimit:${clientId}`).row()
    .text(`📝 Дневной: ${dailyLimit}`, `${CALLBACK_PREFIX}:set_dailylimit:${clientId}`).row()
    .text(`${policy?.blockUnlimitedApprovals ? '🟢 Разрешить' : '🔴 Блокировать'} unlimited approvals`, `${CALLBACK_PREFIX}:toggle_approvals:${clientId}`).row()
    .text(`${policy?.blockUnknownContracts ? '🟢 Разрешить' : '🔴 Блокировать'} unknown contracts`, `${CALLBACK_PREFIX}:toggle_unknown:${clientId}`).row();

  if (policy?.maxTransactionUsd) {
    keyboard.text('🗑 Убрать лимит tx', `${CALLBACK_PREFIX}:clear_txlimit:${clientId}`);
  }
  if (policy?.dailyLimitUsd) {
    keyboard.text('🗑 Убрать дневной', `${CALLBACK_PREFIX}:clear_dailylimit:${clientId}`);
  }
  keyboard.row().text('← Назад', `${CALLBACK_PREFIX}:view:${clientId}`);

  await ctx.editMessageText(
    `⚙️ *Политика: ${escapeMarkdown(client.name)}*\n\n` +
    `Лимит транзакции: ${escapeMarkdown(maxTx)}\n` +
    `Дневной лимит: ${escapeMarkdown(dailyLimit)}\n` +
    `Unlimited approvals: ${unlimited}\n` +
    `Unknown contracts: ${unknown}`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    }
  );
}

async function handleToggleApprovals(ctx: BotContext, clientId: string): Promise<void> {
  const policy = await prisma.policy.findUnique({ where: { clientId } });
  if (!policy) return;
  await prisma.policy.update({
    where: { clientId },
    data: { blockUnlimitedApprovals: !policy.blockUnlimitedApprovals },
  });
  await audit({
    action: 'policy.update',
    actorId: ctx.from?.id,
    actorName: ctx.from?.username || ctx.from?.first_name,
    targetId: clientId,
    targetType: 'policy',
    details: { field: 'blockUnlimitedApprovals', value: !policy.blockUnlimitedApprovals },
  });
  await handleViewPolicy(ctx, clientId);
}

async function handleToggleUnknown(ctx: BotContext, clientId: string): Promise<void> {
  const policy = await prisma.policy.findUnique({ where: { clientId } });
  if (!policy) return;
  await prisma.policy.update({
    where: { clientId },
    data: { blockUnknownContracts: !policy.blockUnknownContracts, warnUnknownContracts: !policy.warnUnknownContracts },
  });
  await audit({
    action: 'policy.update',
    actorId: ctx.from?.id,
    actorName: ctx.from?.username || ctx.from?.first_name,
    targetId: clientId,
    targetType: 'policy',
    details: { field: 'blockUnknownContracts', value: !policy.blockUnknownContracts },
  });
  await handleViewPolicy(ctx, clientId);
}

async function handleSetTxLimitStart(ctx: BotContext, clientId: string): Promise<void> {
  ctx.session.step = `policy_txlimit:${clientId}`;
  const cancelKb = new InlineKeyboard().text('← Отмена', `${CALLBACK_PREFIX}:policy:${clientId}`);
  await ctx.editMessageText(
    '💰 *Лимит транзакции*\n\nВведите максимальную сумму в USD:\n_Пример: 10000_',
    { parse_mode: 'MarkdownV2', reply_markup: cancelKb }
  );
}

async function handleSetDailyLimitStart(ctx: BotContext, clientId: string): Promise<void> {
  ctx.session.step = `policy_dailylimit:${clientId}`;
  const cancelKb = new InlineKeyboard().text('← Отмена', `${CALLBACK_PREFIX}:policy:${clientId}`);
  await ctx.editMessageText(
    '💰 *Дневной лимит*\n\nВведите максимальную сумму в USD за день:\n_Пример: 50000_',
    { parse_mode: 'MarkdownV2', reply_markup: cancelKb }
  );
}

async function handleClearLimit(ctx: BotContext, clientId: string, field: 'maxTransactionUsd' | 'dailyLimitUsd'): Promise<void> {
  await prisma.policy.update({
    where: { clientId },
    data: { [field]: null },
  });
  await audit({
    action: 'policy.update',
    actorId: ctx.from?.id,
    actorName: ctx.from?.username || ctx.from?.first_name,
    targetId: clientId,
    targetType: 'policy',
    details: { field, value: null },
  });
  await handleViewPolicy(ctx, clientId);
}

async function handleAddWalletStart(ctx: BotContext, clientId: string): Promise<void> {
  ctx.session.step = `addwallet::${clientId}`;

  const walletCancelKb = new InlineKeyboard().text('← Отмена', `${CALLBACK_PREFIX}:view:${clientId}`);
  await ctx.editMessageText(
    '➕ *Добавление кошелька*\n\n' +
    'Введите адрес кошелька и Chain ID через пробел:\n' +
    'Пример: `0x123\\.\\.\\. 1`\n\n' +
    'Chain IDs:\n' +
    '• 1 \\- Ethereum\n' +
    '• 42161 \\- Arbitrum\n' +
    '• 8453 \\- Base\n' +
    '• 137 \\- Polygon\n' +
    '• 10 \\- Optimism\n' +
    '• 56 \\- BNB Chain\n' +
    '• 43114 \\- Avalanche\n' +
    '• 59144 \\- Linea',
    { parse_mode: 'MarkdownV2', reply_markup: walletCancelKb }
  );
}

async function handleRemoveWalletConfirm(ctx: BotContext, walletId: string, clientId: string): Promise<void> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) return;

  const keyboard = new InlineKeyboard()
    .text('Да, удалить', `${CALLBACK_PREFIX}:rmwallet_ok:${walletId}:${clientId}`)
    .text('Отмена', `${CALLBACK_PREFIX}:wallets:${clientId}`);

  await ctx.editMessageText(
    `⚠️ *Удалить кошелёк?*\n\n\`${escapeMarkdown(formatAddress(wallet.address))}\`\nChain: ${wallet.chainId}`,
    { parse_mode: 'MarkdownV2', reply_markup: keyboard }
  );
}

async function handleRemoveWallet(ctx: BotContext, walletId: string, clientId: string): Promise<void> {
  try {
    const wallet = await prisma.wallet.update({
      where: { id: walletId },
      data: { isActive: false },
    });

    await audit({
      action: 'wallet.remove',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: walletId,
      targetType: 'wallet',
      details: { address: wallet.address, clientId, adminAction: true },
    });

    await handleViewWallets(ctx, clientId);
  } catch {
    await ctx.editMessageText('❌ Ошибка при удалении кошелька\\.');
  }
}

async function handleDeleteConfirm(ctx: BotContext, clientId: string): Promise<void> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { name: true },
  });

  const keyboard = new InlineKeyboard()
    .text('⚠️ Да, удалить', `${CALLBACK_PREFIX}:delete_confirm:${clientId}`)
    .text('Отмена', `${CALLBACK_PREFIX}:view:${clientId}`);

  await ctx.editMessageText(
    `🗑 *Удаление клиента*\n\n` +
    `Вы уверены, что хотите удалить клиента *${escapeMarkdown(client?.name || '')}*?\n\n` +
    `Это действие необратимо\\!`,
    {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    }
  );
}

async function handleDeleteClient(ctx: BotContext, clientId: string): Promise<void> {
  await prisma.client.delete({ where: { id: clientId } });

  const deletedKb = new InlineKeyboard().text('← Главное меню', 'menu:back_admin');
  await ctx.editMessageText('✅ Клиент удалён\\.', { parse_mode: 'MarkdownV2', reply_markup: deletedKb });
}

const SAFE_SERVICE_PREFIXES: Record<number, string> = {
  1: 'eth', 42161: 'arb1', 8453: 'base', 137: 'pol',
  10: 'oeth', 56: 'bnb', 43114: 'avax', 59144: 'linea',
};

async function detectWalletType(address: string, chainId = 1): Promise<WalletType> {
  const prefix = SAFE_SERVICE_PREFIXES[chainId] || 'eth';
  try {
    const response = await axios.get(
      `https://api.safe.global/tx-service/${prefix}/api/v1/safes/${address}/`,
      { timeout: 5000 }
    );
    if (response.status === 200) return 'safe';
  } catch {
  }
  return 'eoa';
}

async function handleBackToClients(ctx: BotContext): Promise<void> {
  const clients = await prisma.client.findMany({
    include: { _count: { select: { wallets: true } } },
    orderBy: { name: 'asc' },
  });

  const keyboard = new InlineKeyboard();
  for (const client of clients) {
    keyboard.text(
      `${client.name} (${client._count.wallets})`,
      `${CALLBACK_PREFIX}:view:${client.id}`
    ).row();
  }
  keyboard.text('➕ Добавить клиента', `${CALLBACK_PREFIX}:add`);

  await ctx.editMessageText(`📋 *Клиенты* \\(${clients.length}\\)`, {
    parse_mode: 'MarkdownV2',
    reply_markup: keyboard,
  });
}
