import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { audit } from '../../audit-log/index.js';
import { validate, clientNameSchema, chatIdSchema, ethereumAddressSchema } from '../../../utils/validators.js';
import type { WalletType } from '../../../models/transaction.js';
import { createLogger } from '../../../utils/logger.js';
import { getBot } from '../index.js';

const logger = createLogger('admin-groups');
const P = 'grp';

const NETWORKS = [
  { chainId: 1, name: 'Ethereum', short: 'ETH' },
  { chainId: 42161, name: 'Arbitrum', short: 'ARB' },
  { chainId: 8453, name: 'Base', short: 'BASE' },
  { chainId: 137, name: 'Polygon', short: 'MATIC' },
  { chainId: 10, name: 'Optimism', short: 'OP' },
  { chainId: 56, name: 'BNB Chain', short: 'BNB' },
  { chainId: 43114, name: 'Avalanche', short: 'AVAX' },
  { chainId: 59144, name: 'Linea', short: 'LINEA' },
];

export function setupGroupsHandlers(bot: Bot<BotContext>): void {
  bot.command('groups', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;
    await showGroupsList(ctx);
  });

  bot.command('addgroup', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;
    await startAddGroup(ctx);
  });

  bot.callbackQuery(new RegExp(`^${P}:`), async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }

    const parts = ctx.callbackQuery.data.split(':');
    const action = parts[1];

    switch (action) {
      case 'list':
        await showGroupsList(ctx, true);
        break;
      case 'view':
        await showGroup(ctx, parts[2]);
        break;
      case 'add':
        await startAddGroup(ctx, true);
        break;
      case 'addw':
        await startAddWallet(ctx, parts[2]);
        break;
      case 'chain': {
        await finishAddWallet(ctx, parts[2], parseInt(parts[3]));
        break;
      }
      case 'rmw':
        await confirmRemoveWallet(ctx, parts[2]);
        break;
      case 'rmw_ok':
        await removeWallet(ctx, parts[2]);
        break;
      case 'del':
        await confirmDeleteGroup(ctx, parts[2]);
        break;
      case 'del_ok':
        await deleteGroup(ctx, parts[2]);
        break;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    const step = ctx.session.step;
    if (!step?.startsWith('grp:')) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return next();
    }

    if (step === 'grp:name') {
      const result = validate(clientNameSchema, text);
      if (!result.success) {
        await ctx.reply(`❌ ${escapeMarkdown(result.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }
      ctx.session.data = { name: result.data };
      ctx.session.step = 'grp:chatid';
      await ctx.reply(
        `Название: *${escapeMarkdown(result.data)}*\n\n` +
        'Введите ID чата Telegram\\-группы:\n' +
        '_Добавьте бота в группу и используйте /chatid_',
        { parse_mode: 'MarkdownV2' }
      );
    } else if (step === 'grp:chatid') {
      const result = validate(chatIdSchema, text);
      if (!result.success) {
        await ctx.reply(`❌ ${escapeMarkdown(result.error)}`);
        return;
      }
      await createGroup(ctx, result.data);
    } else if (step.startsWith('grp:wallet:')) {
      const groupId = step.replace('grp:wallet:', '');
      const result = validate(ethereumAddressSchema, text);
      if (!result.success) {
        await ctx.reply(`❌ ${escapeMarkdown(result.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }

      ctx.session.data = { address: result.data };
      ctx.session.step = `grp:chain_wait:${groupId}`;

      const kb = new InlineKeyboard();
      for (let i = 0; i < NETWORKS.length; i++) {
        kb.text(NETWORKS[i].short, `${P}:chain:${groupId}:${NETWORKS[i].chainId}`);
        if ((i + 1) % 4 === 0) kb.row();
      }
      kb.row().text('← Отмена', `${P}:view:${groupId}`);

      await ctx.reply(
        `Адрес: \`${escapeMarkdown(result.data.slice(0, 10))}\\.\\.\\.\`\n\nВыберите сеть:`,
        { parse_mode: 'MarkdownV2', reply_markup: kb }
      );
    }
  });
}

export async function showGroupsList(ctx: BotContext, edit = false): Promise<void> {
  const groups = await prisma.client.findMany({
    include: { _count: { select: { wallets: { where: { isActive: true } } } } },
    orderBy: { name: 'asc' },
  });

  const kb = new InlineKeyboard();
  for (const g of groups) {
    kb.text(`${g.name} (${g._count.wallets})`, `${P}:view:${g.id}`).row();
  }
  kb.text('➕ Новая группа', `${P}:add`).row();
  kb.text('← Назад', 'menu:back_admin');

  const text = groups.length
    ? `📋 *Группы* \\(${groups.length}\\)`
    : '📋 *Группы*\n\n_Групп пока нет\\._';

  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

async function showGroup(ctx: BotContext, groupId: string): Promise<void> {
  const group = await prisma.client.findUnique({
    where: { id: groupId },
    include: { wallets: { where: { isActive: true }, orderBy: { createdAt: 'desc' } } },
  });

  if (!group) return;

  let text = `📁 *${escapeMarkdown(group.name)}*\n` +
    `Чат: \`${group.telegramChatId.toString()}\`\n\n`;

  if (group.wallets.length === 0) {
    text += '_Кошельков нет_\n';
  } else {
    text += `*Кошельки \\(${group.wallets.length}\\):*\n`;
    for (const w of group.wallets) {
      const net = NETWORKS.find(n => n.chainId === w.chainId);
      const type = w.type === 'safe' ? 'Safe' : 'EOA';
      text += `\`${escapeMarkdown(w.address)}\`\n  ${escapeMarkdown(net?.name || `Chain ${w.chainId}`)} \\| ${type}\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const w of group.wallets.slice(0, 8)) {
    const net = NETWORKS.find(n => n.chainId === w.chainId);
    const short = `${w.address.slice(0, 6)}..${w.address.slice(-4)}`;
    kb.text(`❌ ${short} ${net?.short || ''}`, `${P}:rmw:${w.id}`).row();
  }
  kb.text('➕ Добавить кошелёк', `${P}:addw:${groupId}`).row();
  kb.text('🗑 Удалить группу', `${P}:del:${groupId}`).row();
  kb.text('← Группы', `${P}:list`);

  try {
    await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } catch {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

async function startAddGroup(ctx: BotContext, edit = false): Promise<void> {
  ctx.session.step = 'grp:name';
  ctx.session.data = undefined;
  const cancelKb = new InlineKeyboard().text('← Отмена', `${P}:list`);
  const text = '➕ *Новая группа*\n\nВведите название группы:';
  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: cancelKb });
    } catch {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: cancelKb });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: cancelKb });
  }
}

async function createGroup(ctx: BotContext, chatId: number): Promise<void> {
  const name = (ctx.session.data as { name?: string })?.name;
  if (!name) {
    ctx.session.step = undefined;
    await ctx.reply('❌ Ошибка\\. Попробуйте /addgroup');
    return;
  }

  const bot = getBot();
  if (bot) {
    try {
      const chat = await bot.api.getChat(chatId);
      const chatType = chat.type;
      if (chatType !== 'group' && chatType !== 'supergroup' && chatType !== 'private') {
        ctx.session.step = undefined;
        ctx.session.data = undefined;
        await ctx.reply('❌ Неверный тип чата\\. Поддерживаются группы и личные чаты\\.');
        return;
      }
    } catch {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      await ctx.reply(
        '❌ Не удалось найти чат\\.\n\n' +
        'Убедитесь что:\n' +
        '1\\. Бот добавлен в группу\n' +
        '2\\. Chat ID указан верно \\(используйте /chatid в группе\\)',
        { parse_mode: 'MarkdownV2' }
      );
      return;
    }
  }

  try {
    const client = await prisma.client.create({
      data: {
        name,
        telegramChatId: BigInt(chatId),
      },
    });
    await prisma.policy.create({ data: { clientId: client.id } });

    await audit({
      action: 'client.create',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: client.id,
      targetType: 'client',
      details: { name, chatId },
    });

    ctx.session.step = undefined;
    ctx.session.data = undefined;

    logger.info({ groupId: client.id, name, chatId }, 'Group created');

    const kb = new InlineKeyboard()
      .text('➕ Добавить кошелёк', `${P}:addw:${client.id}`).row()
      .text('← Группы', `${P}:list`);

    await ctx.reply(
      `✅ Группа *${escapeMarkdown(name)}* создана\\!\n\nЧат: \`${chatId}\``,
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  } catch {
    ctx.session.step = undefined;
    ctx.session.data = undefined;
    await ctx.reply('❌ Ошибка\\. Возможно, чат уже привязан\\.');
  }
}

async function startAddWallet(ctx: BotContext, groupId: string): Promise<void> {
  ctx.session.step = `grp:wallet:${groupId}`;
  ctx.session.data = undefined;
  const cancelKb = new InlineKeyboard().text('← Отмена', `${P}:view:${groupId}`);
  try {
    await ctx.editMessageText(
      '➕ *Добавить кошелёк*\n\nВведите адрес кошелька \\(0x\\.\\.\\.\\):',
      { parse_mode: 'MarkdownV2', reply_markup: cancelKb }
    );
  } catch {
    await ctx.reply(
      '➕ *Добавить кошелёк*\n\nВведите адрес кошелька \\(0x\\.\\.\\.\\):',
      { parse_mode: 'MarkdownV2', reply_markup: cancelKb }
    );
  }
}

async function finishAddWallet(ctx: BotContext, groupId: string, chainId: number): Promise<void> {
  const address = (ctx.session.data as { address?: string })?.address;
  if (!address) {
    await ctx.editMessageText('❌ Ошибка\\. Попробуйте снова\\.');
    return;
  }

  try {
    const existing = await prisma.wallet.findUnique({
      where: { address_chainId: { address, chainId } },
    });
    if (existing) {
      const kb = new InlineKeyboard().text('← Назад', `${P}:view:${groupId}`);
      await ctx.editMessageText('❌ Этот кошелёк уже отслеживается в данной сети\\.', {
        parse_mode: 'MarkdownV2', reply_markup: kb,
      });
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return;
    }

    const walletType = await detectWalletType(address, chainId);
    const wallet = await prisma.wallet.create({
      data: {
        clientId: groupId,
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
      details: { groupId, address, chainId, walletType },
    });

    ctx.session.step = undefined;
    ctx.session.data = undefined;

    const net = NETWORKS.find(n => n.chainId === chainId);
    logger.info({ groupId, walletId: wallet.id, address, chainId, walletType }, 'Wallet added to group');

    const kb = new InlineKeyboard()
      .text('➕ Ещё кошелёк', `${P}:addw:${groupId}`)
      .text('← Группа', `${P}:view:${groupId}`);

    await ctx.editMessageText(
      `✅ *Кошелёк добавлен\\!*\n\n` +
      `\`${escapeMarkdown(address)}\`\n` +
      `${escapeMarkdown(net?.name || `Chain ${chainId}`)} \\| ${walletType === 'safe' ? 'Safe' : 'EOA'}`,
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  } catch {
    ctx.session.step = undefined;
    ctx.session.data = undefined;
    await ctx.editMessageText('❌ Ошибка\\. Возможно, кошелёк уже существует\\.');
  }
}

async function confirmRemoveWallet(ctx: BotContext, walletId: string): Promise<void> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet) return;

  const net = NETWORKS.find(n => n.chainId === wallet.chainId);
  const kb = new InlineKeyboard()
    .text('Да, удалить', `${P}:rmw_ok:${walletId}`)
    .text('Отмена', `${P}:view:${wallet.clientId}`);

  await ctx.editMessageText(
    `⚠️ *Удалить кошелёк?*\n\n\`${escapeMarkdown(wallet.address)}\`\n${escapeMarkdown(net?.name || `Chain ${wallet.chainId}`)}`,
    { parse_mode: 'MarkdownV2', reply_markup: kb }
  );
}

async function removeWallet(ctx: BotContext, walletId: string): Promise<void> {
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
      details: { address: wallet.address, groupId: wallet.clientId },
    });

    logger.info({ groupId: wallet.clientId, walletId, address: wallet.address }, 'Wallet removed from group');
    await showGroup(ctx, wallet.clientId);
  } catch {
    await ctx.editMessageText('❌ Ошибка при удалении\\.');
  }
}

async function confirmDeleteGroup(ctx: BotContext, groupId: string): Promise<void> {
  const group = await prisma.client.findUnique({ where: { id: groupId }, select: { name: true } });
  if (!group) return;

  const kb = new InlineKeyboard()
    .text('⚠️ Да, удалить', `${P}:del_ok:${groupId}`)
    .text('Отмена', `${P}:view:${groupId}`);

  await ctx.editMessageText(
    `🗑 *Удалить группу ${escapeMarkdown(group.name)}?*\n\n` +
    'Все кошельки будут отвязаны\\. История сохранится\\.',
    { parse_mode: 'MarkdownV2', reply_markup: kb }
  );
}

async function deleteGroup(ctx: BotContext, groupId: string): Promise<void> {
  const group = await prisma.client.findUnique({
    where: { id: groupId },
    select: { name: true, wallets: { select: { id: true } } },
  });
  if (!group) return;

  try {
    const walletIds = group.wallets.map(w => w.id);
    if (walletIds.length > 0) {
      await prisma.transactionHistory.deleteMany({ where: { walletId: { in: walletIds } } });
    }

    await prisma.client.delete({ where: { id: groupId } });

    await audit({
      action: 'client.delete',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: groupId,
      targetType: 'client',
      details: { name: group.name },
    });

    logger.info({ groupId, name: group.name }, 'Group deleted');
    await showGroupsList(ctx, true);
  } catch (error) {
    logger.error({ error, groupId }, 'Failed to delete group');
    try {
      await ctx.editMessageText('❌ Ошибка при удалении группы\\.');
    } catch {
      await ctx.reply('❌ Ошибка при удалении группы\\.');
    }
  }
}

const SAFE_PREFIXES: Record<number, string> = {
  1: 'eth', 42161: 'arb1', 8453: 'base', 137: 'pol',
  10: 'oeth', 56: 'bnb', 43114: 'avax', 59144: 'linea',
};

async function detectWalletType(address: string, chainId = 1): Promise<WalletType> {
  const prefix = SAFE_PREFIXES[chainId] || 'eth';
  try {
    const res = await axios.get(
      `https://api.safe.global/tx-service/${prefix}/api/v1/safes/${address}/`,
      { timeout: 5000 }
    );
    if (res.status === 200) return 'safe';
  } catch {}
  return 'eoa';
}
