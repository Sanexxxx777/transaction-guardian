import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { prisma } from '../../../db/index.js';
import { createLogger } from '../../../utils/logger.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { audit } from '../../audit-log/index.js';

const logger = createLogger('user-wallets');

const NETWORKS = [
  { chainId: 1, name: 'Ethereum', shortName: 'ETH' },
  { chainId: 42161, name: 'Arbitrum', shortName: 'ARB' },
  { chainId: 8453, name: 'Base', shortName: 'BASE' },
  { chainId: 137, name: 'Polygon', shortName: 'MATIC' },
  { chainId: 10, name: 'Optimism', shortName: 'OP' },
  { chainId: 56, name: 'BNB Chain', shortName: 'BNB' },
  { chainId: 43114, name: 'Avalanche', shortName: 'AVAX' },
  { chainId: 59144, name: 'Linea', shortName: 'LINEA' },
];

interface EoaFilters {
  incoming: boolean;
  outgoing: boolean;
  contractCalls: boolean;
  approvals: boolean;
}

const DEFAULT_EOA_FILTERS: EoaFilters = {
  incoming: true,
  outgoing: true,
  contractCalls: true,
  approvals: true,
};

function getEoaFilters(raw: unknown): EoaFilters {
  const f = raw as Partial<EoaFilters> | null;
  return {
    incoming: f?.incoming ?? true,
    outgoing: f?.outgoing ?? true,
    contractCalls: f?.contractCalls ?? true,
    approvals: f?.approvals ?? true,
  };
}

export function setupUserWalletHandlers(bot: Bot<BotContext>): void {
  bot.command('wallets', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;

    const { checkIsAdmin } = await import('../index.js');
    const isAdmin = await checkIsAdmin(ctx.from?.id);
    if (isAdmin) {
      const { showAdminWalletList } = await import('../admin/wallets.js');
      await showAdminWalletList(ctx);
      return;
    }

    const client = await getClientByUserId(ctx.from?.id);
    if (client) {
      await showWalletList(ctx, client.id);
      return;
    }

    await ctx.reply(
      'Управление кошельками доступно только администраторам\\.\n' +
      'Для подключения обратитесь к администратору',
      { parse_mode: 'MarkdownV2', link_preview_options: { is_disabled: true } }
    );
  });

  bot.callbackQuery('uw:list', async (ctx) => {
    await ctx.answerCallbackQuery();
    const client = await getClientByUserId(ctx.from?.id);
    if (!client) return;
    await showWalletList(ctx, client.id, true);
  });

  bot.callbackQuery(/^uw:toggle:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = ctx.callbackQuery.data.replace('uw:toggle:', '');
    const userId = ctx.from?.id;

    try {
      const client = await getClientByUserId(userId);
      if (!client) return;

      const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
      if (!wallet || wallet.clientId !== client.id) return;

      const newEnabled = !wallet.monitoringEnabled;
      await prisma.wallet.update({
        where: { id: walletId },
        data: { monitoringEnabled: newEnabled },
      });

      await audit({
        action: 'wallet.toggle',
        actorId: userId,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: walletId,
        targetType: 'wallet',
        details: { address: wallet.address, monitoringEnabled: newEnabled },
      });

      logger.info({ userId, walletId, monitoringEnabled: newEnabled }, 'User toggled wallet monitoring');
      await showWalletList(ctx, client.id, true);
    } catch (error) {
      logger.error({ error, walletId }, 'Failed to toggle wallet monitoring');
    }
  });

  bot.callbackQuery(/^uw:filters:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = ctx.callbackQuery.data.replace('uw:filters:', '');

    const client = await getClientByUserId(ctx.from?.id);
    if (!client) return;
    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.clientId !== client.id) return;
    await showEoaFilters(ctx, walletId);
  });

  bot.callbackQuery(/^uw:filter:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const [, , walletId, filterKey] = ctx.callbackQuery.data.split(':');
    if (!walletId || !filterKey) return;

    try {
      const client = await getClientByUserId(ctx.from?.id);
      if (!client) return;

      const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
      if (!wallet || wallet.type !== 'eoa' || wallet.clientId !== client.id) return;

      const current = getEoaFilters(wallet.eoaFilters);
      const validKeys = ['incoming', 'outgoing', 'contractCalls', 'approvals'] as const;
      const key = filterKey as typeof validKeys[number];
      if (!validKeys.includes(key)) return;

      current[key] = !current[key];
      await prisma.wallet.update({
        where: { id: walletId },
        data: { eoaFilters: current as unknown as Record<string, boolean> },
      });

      await showEoaFilters(ctx, walletId, true);
    } catch (error) {
      logger.error({ error, walletId, filterKey }, 'Failed to toggle EOA filter');
    }
  });

  bot.callbackQuery(/^uw:rm:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = ctx.callbackQuery.data.replace('uw:rm:', '');

    const client = await getClientByUserId(ctx.from?.id);
    if (!client) return;

    const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
    if (!wallet || wallet.clientId !== client.id) return;

    const kb = new InlineKeyboard()
      .text('Да, удалить', `uw:rmok:${walletId}`)
      .text('Отмена', 'uw:list');

    await ctx.editMessageText(
      '⚠️ *Удалить кошелёк?*\n\n' +
      `\`${escapeMarkdown(wallet.address.slice(0, 10))}\\.\\.\\.\`\n\n` +
      'История транзакций будет сохранена\\.',
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  });

  bot.callbackQuery(/^uw:rmok:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const walletId = ctx.callbackQuery.data.replace('uw:rmok:', '');
    const userId = ctx.from?.id;

    try {
      const client = await getClientByUserId(userId);
      if (!client) return;

      const existing = await prisma.wallet.findUnique({ where: { id: walletId } });
      if (!existing || existing.clientId !== client.id) return;

      const wallet = await prisma.wallet.update({
        where: { id: walletId },
        data: { isActive: false },
      });

      await audit({
        action: 'wallet.remove',
        actorId: userId,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: walletId,
        targetType: 'wallet',
        details: { address: wallet.address, selfService: true },
      });

      await showWalletList(ctx, client.id, true);

      logger.info({ userId, walletId }, 'User removed wallet');
    } catch (error) {
      logger.error({ error, walletId }, 'Failed to remove wallet');
      await ctx.editMessageText('❌ Ошибка при удалении\\.');
    }
  });
}

async function showWalletList(ctx: BotContext, clientId: string, edit = false): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { clientId, isActive: true },
    orderBy: { createdAt: 'desc' },
  });

  let text = `👛 *Кошельки \\(${wallets.length}\\)*\n\n`;

  if (wallets.length === 0) {
    text += '_Нет кошельков\\._\n';
  } else {
    for (const w of wallets) {
      const network = NETWORKS.find(n => n.chainId === w.chainId);
      const typeLabel = w.type === 'safe' ? 'Safe' : 'EOA';
      text += `\`${w.address}\` ${escapeMarkdown(network?.shortName || '?')} ${typeLabel}\n`;
    }
  }

  const kb = new InlineKeyboard();

  for (const w of wallets.slice(0, 5)) {
    const network = NETWORKS.find(n => n.chainId === w.chainId);
    const shortAddr = `${w.address.slice(0, 4)}..${w.address.slice(-3)}`;
    const net = network?.shortName || '?';
    const monLabel = w.monitoringEnabled ? `🔕 Выкл (${shortAddr} ${net})` : `🔔 Вкл (${shortAddr} ${net})`;

    if (w.type === 'eoa') {
      kb.text(monLabel, `uw:toggle:${w.id}`)
        .text('⚙️', `uw:filters:${w.id}`)
        .text('❌', `uw:rm:${w.id}`)
        .row();
    } else {
      kb.text(monLabel, `uw:toggle:${w.id}`)
        .text('❌', `uw:rm:${w.id}`)
        .row();
    }
  }

  kb.text('← Назад', 'menu:back_user');

  const method = edit ? ctx.editMessageText.bind(ctx) : ctx.reply.bind(ctx);
  await method(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
}

async function showEoaFilters(ctx: BotContext, walletId: string, isEdit = false): Promise<void> {
  const wallet = await prisma.wallet.findUnique({ where: { id: walletId } });
  if (!wallet || wallet.type !== 'eoa') return;

  const network = NETWORKS.find(n => n.chainId === wallet.chainId);
  const shortAddr = `${wallet.address.slice(0, 6)}...${wallet.address.slice(-4)}`;
  const filters = getEoaFilters(wallet.eoaFilters);

  const on = (v: boolean) => v ? '✅' : '❌';

  const text =
    `⚙️ *Фильтры мониторинга EOA*\n\n` +
    `👛 \`${escapeMarkdown(shortAddr)}\` ${escapeMarkdown(network?.shortName || '?')}\n\n` +
    `📥 Входящие: ${on(filters.incoming)}\n` +
    `📤 Исходящие: ${on(filters.outgoing)}\n` +
    `🔄 Контракты: ${on(filters.contractCalls)}\n` +
    `🔏 Approvals: ${on(filters.approvals)}\n\n` +
    `_Нажмите кнопку чтобы включить/выключить_`;

  const kb = new InlineKeyboard()
    .text(`📥 Входящие ${on(filters.incoming)}`, `uw:filter:${walletId}:incoming`)
    .text(`📤 Исходящие ${on(filters.outgoing)}`, `uw:filter:${walletId}:outgoing`)
    .row()
    .text(`🔄 Контракты ${on(filters.contractCalls)}`, `uw:filter:${walletId}:contractCalls`)
    .text(`🔏 Approvals ${on(filters.approvals)}`, `uw:filter:${walletId}:approvals`)
    .row()
    .text('← Кошельки', 'uw:list');

  if (isEdit) {
    try {
      await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
    } catch {
      await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
    }
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

function backToWalletsKb(): InlineKeyboard {
  return new InlineKeyboard().text('← Кошельки', 'uw:list');
}

async function getClientByUserId(userId: number | undefined): Promise<{ id: string } | null> {
  if (!userId) return null;
  return prisma.client.findUnique({
    where: { telegramUserId: BigInt(userId) },
    select: { id: true },
  });
}
