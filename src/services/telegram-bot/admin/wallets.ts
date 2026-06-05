import { Bot, InlineKeyboard } from 'grammy';
import axios from 'axios';
import { getAddress } from 'ethers';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { prisma } from '../../../db/index.js';
import { config } from '../../../config/index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { validate, ethereumAddressSchema } from '../../../utils/validators.js';
import { audit } from '../../audit-log/index.js';
import { createLogger } from '../../../utils/logger.js';
import type { WalletType } from '../../../models/transaction.js';

const logger = createLogger('admin-wallets');
const P = 'aw';

const NETWORKS = [
  { id: 1, name: 'Ethereum', short: 'ETH' },
  { id: 42161, name: 'Arbitrum', short: 'ARB' },
  { id: 8453, name: 'Base', short: 'BASE' },
  { id: 137, name: 'Polygon', short: 'MATIC' },
  { id: 10, name: 'Optimism', short: 'OP' },
  { id: 56, name: 'BNB Chain', short: 'BNB' },
  { id: 43114, name: 'Avalanche', short: 'AVAX' },
  { id: 59144, name: 'Linea', short: 'LINEA' },
];

function netName(chainId: number): string {
  return NETWORKS.find(n => n.id === chainId)?.short || `${chainId}`;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function checkSafeOnChain(
  address: string,
  chainId: number,
  safeTxServiceUrl: string,
): Promise<boolean> {
  let checksum: string;
  try {
    checksum = getAddress(address);
  } catch {
    return false;
  }
  const headers: Record<string, string> = {};
  if (config.safe.apiKey) headers['Authorization'] = `Bearer ${config.safe.apiKey}`;
  const url = `${safeTxServiceUrl.replace(/\/$/, '')}/api/v1/safes/${checksum}/`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await axios.get(url, { timeout: 6000, headers, validateStatus: () => true });
      if (res.status === 200) return true;
      if (res.status === 429) {
        await sleep(1500);
        continue;
      }
      return false;
    } catch (err) {
      logger.debug({ err, chainId }, 'checkSafeOnChain request error');
      return false;
    }
  }
  return false;
}

async function scanNetworks(address: string): Promise<{ safeOn: number[]; allChainIds: number[] }> {
  const networks = await prisma.network.findMany({
    where: { isEnabled: true },
    select: { chainId: true, safeTxServiceUrl: true },
  });

  const safeOn: number[] = [];
  for (const n of networks) {
    if (await checkSafeOnChain(address, n.chainId, n.safeTxServiceUrl)) {
      safeOn.push(n.chainId);
    }
    await sleep(150);
  }

  return { safeOn, allChainIds: networks.map(n => n.chainId) };
}

interface ScanSession {
  groupId: string;
  address: string;
  safeOn: number[];
  allChainIds: number[];
}

export function setupAdminWalletsHandlers(bot: Bot<BotContext>): void {
  bot.callbackQuery(new RegExp(`^${P}:`), async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }

    const parts = ctx.callbackQuery.data.split(':');
    const action = parts[1];

    switch (action) {
      case 'list': await showWalletList(ctx); break;
      case 'add': await startAddWallet(ctx); break;
      case 'grp': await selectGroup(ctx); break;
      case 'sgrp': {
        await promptForAddress(ctx, parts[2]);
        break;
      }
      case 'net': {
        await finishAddWallet(ctx, parseInt(parts[2]));
        break;
      }
      case 'add_all': {
        await finishBulkAddWallet(ctx);
        break;
      }
      case 'batch_add': {
        await finishBatchAddSafe(ctx);
        break;
      }
      case 'manual': {
        await showManualNetworkPicker(ctx);
        break;
      }
      case 'dl': {
        const address = parts[2];
        await startAddWalletDeepLink(ctx, address);
        break;
      }
      case 'rm': await confirmRemove(ctx, parts[2]); break;
      case 'rm_ok': await removeWallet(ctx, parts[2]); break;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    const step = ctx.session.step;
    if (!step?.startsWith('aw:')) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return next();
    }

    if (step === 'aw:addr') {
      const groupId = (ctx.session.data as { groupId?: string } | null)?.groupId;
      if (!groupId) {
        await ctx.reply('❌ Сессия истекла, начните сначала через /addwallet', { parse_mode: 'MarkdownV2' });
        ctx.session.step = undefined;
        ctx.session.data = undefined;
        return;
      }

      if (text.includes(',')) {
        await handleBatchAddressInput(ctx, text, groupId);
        return;
      }

      const result = validate(ethereumAddressSchema, text);
      if (!result.success) {
        await ctx.reply(`❌ ${escapeMarkdown(result.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }

      await runSingleAddressScan(ctx, groupId, result.data);
    }
  });
}

async function runSingleAddressScan(ctx: BotContext, groupId: string, address: string): Promise<void> {
  const scanMsg = await ctx.reply(
    `Адрес: \`${escapeMarkdown(address.slice(0, 10))}\\.\\.\\.\`\n\n🔍 _Сканирую сети\\.\\.\\._`,
    { parse_mode: 'MarkdownV2' },
  );

  const { safeOn, allChainIds } = await scanNetworks(address);

  const session: ScanSession = { groupId, address, safeOn, allChainIds };
  ctx.session.data = session;
  ctx.session.step = 'aw:scan_done';

  const kb = new InlineKeyboard();
  let body: string;

  if (safeOn.length > 0) {
    const list = safeOn.map(netName).join(', ');
    body =
      `Адрес: \`${escapeMarkdown(address)}\`\n\n` +
      `✅ Это *Safe* на ${safeOn.length} сет${pluralSeti(safeOn.length)}: ${escapeMarkdown(list)}\n\n` +
      `Добавить во все эти сети?`;
    kb.text(`✅ Добавить (Safe × ${safeOn.length})`, `${P}:add_all`).row();
  } else {
    const list = allChainIds.map(netName).join(', ');
    body =
      `Адрес: \`${escapeMarkdown(address)}\`\n\n` +
      `ℹ️ Не обнаружен как Safe ни на одной сети — *EOA*\\.\n\n` +
      `Добавить как EOA на все ${allChainIds.length} сет${pluralSeti(allChainIds.length)} \\(${escapeMarkdown(list)}\\)?`;
    kb.text(`✅ Добавить EOA на все`, `${P}:add_all`).row();
  }

  kb.text('🛠 Выбрать вручную', `${P}:manual`).row();
  kb.text('← Отмена', `${P}:list`);

  try {
    await ctx.api.editMessageText(scanMsg.chat.id, scanMsg.message_id, body, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
  } catch {
    await ctx.reply(body, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

export async function startAddWalletDeepLink(ctx: BotContext, address: string): Promise<void> {
  const validated = validate(ethereumAddressSchema, address);
  if (!validated.success) {
    await ctx.reply(`❌ ${escapeMarkdown(validated.error)}`, { parse_mode: 'MarkdownV2' });
    return;
  }

  ctx.session.data = { prefilledAddress: validated.data };
  ctx.session.step = undefined;
  await selectGroup(ctx);
}

const BATCH_MAX_ADDRESSES = 30;

interface BatchScanResult {
  address: string;
  safeOn: number[];

  isEoa: boolean;
}

interface BatchScanSession {
  groupId: string;
  results: BatchScanResult[];
}

async function handleBatchAddressInput(ctx: BotContext, text: string, groupId: string): Promise<void> {
  const rawTokens = text.split(',').map(s => s.trim()).filter(Boolean);
  if (rawTokens.length === 0) {
    await ctx.reply('❌ Список пуст\\.', { parse_mode: 'MarkdownV2' });
    return;
  }
  if (rawTokens.length > BATCH_MAX_ADDRESSES) {
    await ctx.reply(
      `❌ За раз можно ${BATCH_MAX_ADDRESSES} адресов \\(пришло ${rawTokens.length}\\)\\. Разбейте список\\.`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  const seen = new Set<string>();
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const tok of rawTokens) {
    const r = validate(ethereumAddressSchema, tok);
    if (!r.success) {
      invalid.push(tok);
      continue;
    }
    const key = r.data.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push(r.data);
  }

  if (valid.length === 0) {
    await ctx.reply(
      `❌ Не нашёл валидных адресов\\. Проверьте формат \\(0x\\.\\.\\.\\)\\.`,
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  const scanMsg = await ctx.reply(
    `🔍 _Сканирую ${valid.length} адрес${pluralAdres(valid.length)} на всех сетях\\.\\.\\._`,
    { parse_mode: 'MarkdownV2' },
  );

  const scanned = await Promise.all(
    valid.map(async addr => ({ address: addr, ...(await scanNetworks(addr)) })),
  );

  const results: BatchScanResult[] = scanned.map(s => ({
    address: s.address,
    safeOn: s.safeOn,
    isEoa: s.safeOn.length === 0,
  }));

  const safeResults = results.filter(r => !r.isEoa);
  const eoaResults = results.filter(r => r.isEoa);
  const totalRows = safeResults.reduce((sum, r) => sum + r.safeOn.length, 0);

  const session: BatchScanSession = { groupId, results: safeResults };

  ctx.session.data = session as unknown as Record<string, unknown>;
  ctx.session.step = 'aw:batch_done';

  const lines: string[] = [];
  lines.push(`*Сканирование завершено* \\(${valid.length} адрес${pluralAdres(valid.length)}\\)`);
  lines.push('');

  if (safeResults.length > 0) {
    lines.push(`✅ *Safe* — ${safeResults.length} адрес${pluralAdres(safeResults.length)}, ${totalRows} запис${pluralZapis(totalRows)} к добавлению:`);
    for (const r of safeResults.slice(0, 20)) {
      const short = `${r.address.slice(0, 8)}\\.\\.${r.address.slice(-4)}`;
      const nets = r.safeOn.map(netName).join(', ');
      lines.push(`  • \`${short}\` → ${escapeMarkdown(nets)}`);
    }
    if (safeResults.length > 20) {
      lines.push(`  _и ещё ${safeResults.length - 20}\\.\\.\\._`);
    }
    lines.push('');
  }

  if (eoaResults.length > 0) {
    lines.push(`↪️ *EOA \\(пропускаются\\)* — ${eoaResults.length} адрес${pluralAdres(eoaResults.length)}:`);
    for (const r of eoaResults.slice(0, 10)) {
      const short = `${r.address.slice(0, 8)}\\.\\.${r.address.slice(-4)}`;
      lines.push(`  • \`${short}\``);
    }
    if (eoaResults.length > 10) {
      lines.push(`  _и ещё ${eoaResults.length - 10}\\.\\.\\._`);
    }
    lines.push(`_Чтобы добавить EOA — отправьте каждый адрес отдельно\\._`);
    lines.push('');
  }

  if (invalid.length > 0) {
    lines.push(`❌ Невалидные \\(${invalid.length}\\): ${escapeMarkdown(invalid.slice(0, 5).join(', '))}${invalid.length > 5 ? '\\.\\.\\.' : ''}`);
    lines.push('');
  }

  const kb = new InlineKeyboard();
  if (safeResults.length > 0) {
    kb.text(`✅ Добавить ${totalRows} запис${pluralZapis(totalRows)}`, `${P}:batch_add`).row();
  }
  kb.text('← Отмена', `${P}:list`);

  const body = lines.join('\n');
  try {
    await ctx.api.editMessageText(scanMsg.chat.id, scanMsg.message_id, body, {
      parse_mode: 'MarkdownV2',
      reply_markup: kb,
    });
  } catch {
    await ctx.reply(body, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

function pluralAdres(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return '';
  if ([2, 3, 4].includes(m10) && ![12, 13, 14].includes(m100)) return 'а';
  return 'ов';
}

function pluralZapis(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'ь';
  if ([2, 3, 4].includes(m10) && ![12, 13, 14].includes(m100)) return 'и';
  return 'ей';
}

function pluralSeti(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'и';
  if ([2, 3, 4].includes(mod10) && ![12, 13, 14].includes(mod100)) return 'ях';
  return 'ях';
}

async function showManualNetworkPicker(ctx: BotContext): Promise<void> {
  const data = ctx.session.data as ScanSession | null;
  if (!data?.address || !data?.groupId) {
    await ctx.editMessageText('❌ Сессия истекла, начните сначала\\.', { parse_mode: 'MarkdownV2' });
    return;
  }
  ctx.session.step = 'aw:net_wait';

  const kb = new InlineKeyboard();
  for (let i = 0; i < NETWORKS.length; i++) {
    const isSafe = data.safeOn.includes(NETWORKS[i].id);
    const label = isSafe ? `${NETWORKS[i].short} ✅` : NETWORKS[i].short;
    kb.text(label, `${P}:net:${NETWORKS[i].id}`);
    if ((i + 1) % 4 === 0) kb.row();
  }
  kb.row().text('← Отмена', `${P}:list`);

  try {
    await ctx.editMessageText(
      `Адрес: \`${escapeMarkdown(data.address)}\`\n\nВыберите сеть \\(✅ — обнаружен Safe\\):`,
      { parse_mode: 'MarkdownV2', reply_markup: kb },
    );
  } catch {
    await ctx.reply(
      `Адрес: \`${escapeMarkdown(data.address)}\`\n\nВыберите сеть \\(✅ — обнаружен Safe\\):`,
      { parse_mode: 'MarkdownV2', reply_markup: kb },
    );
  }
}

export async function showAdminWalletList(ctx: BotContext): Promise<void> {
  return showWalletList(ctx);
}

async function showWalletList(ctx: BotContext): Promise<void> {
  const wallets = await prisma.wallet.findMany({
    where: { isActive: true },
    include: { client: { select: { name: true } } },
    orderBy: [{ client: { name: 'asc' } }, { createdAt: 'desc' }],
  });

  let text = `👛 *Кошельки* \\(${wallets.length}\\)\n\n`;
  if (wallets.length === 0) {
    text += '_Нет кошельков_\n';
  } else {
    let currentGroup = '';
    for (const w of wallets) {
      const groupName = w.client?.name || '?';
      if (groupName !== currentGroup) {
        currentGroup = groupName;
        text += `*${escapeMarkdown(groupName)}:*\n`;
      }
      const short = `${w.address.slice(0, 6)}..${w.address.slice(-4)}`;
      const net = netName(w.chainId);
      const type = w.type === 'safe' ? 'Safe' : 'EOA';
      text += `  \`${short}\` ${net} ${type}\n`;
    }
  }

  const kb = new InlineKeyboard();

  for (const w of wallets.slice(0, 6)) {
    const short = `${w.address.slice(0, 4)}..${w.address.slice(-3)}`;
    const net = netName(w.chainId);
    kb.text(`❌ ${short} ${net}`, `${P}:rm:${w.id}`).row();
  }
  if (wallets.length > 6) {
    kb.text(`... ещё ${wallets.length - 6}`, `${P}:list`).row();
  }
  kb.text('➕ Добавить кошелёк', `${P}:add`).row();
  kb.text('← Назад', 'menu:back_admin');

  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function startAddWallet(ctx: BotContext): Promise<void> {
  await selectGroup(ctx);
}

async function selectGroup(ctx: BotContext): Promise<void> {
  const groups = await prisma.client.findMany({ orderBy: { name: 'asc' } });

  if (groups.length === 0) {
    const created = await maybeAutoCreateDefaultGroup(ctx);
    if (created) {
      await promptForAddress(ctx, created.id, `Создал группу *${escapeMarkdown(created.name)}* — авто-алерты пойдут вам в личку\\.`);
    } else {
      const kb = new InlineKeyboard().text('← Назад', `${P}:list`);
      const text = 'Нет групп, и не задан `TELEGRAM_ADMIN_USER_ID` для автосоздания\\.\nСначала создайте группу через /groups';
      try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
      catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
    }
    return;
  }

  if (groups.length === 1) {
    await promptForAddress(ctx, groups[0].id, `Группа: *${escapeMarkdown(groups[0].name)}*`);
    return;
  }

  const kb = new InlineKeyboard();
  for (const g of groups) {
    kb.text(g.name, `${P}:sgrp:${g.id}`).row();
  }
  kb.text('← Отмена', `${P}:list`);

  try {
    await ctx.editMessageText('➕ *Добавить кошелёк*\n\nВыберите группу:', {
      parse_mode: 'MarkdownV2', reply_markup: kb,
    });
  } catch {
    await ctx.reply('➕ *Добавить кошелёк*\n\nВыберите группу:', {
      parse_mode: 'MarkdownV2', reply_markup: kb,
    });
  }
}

async function promptForAddress(ctx: BotContext, groupId: string, prefix?: string): Promise<void> {
  const prefilled = (ctx.session.data as { prefilledAddress?: string } | null)?.prefilledAddress;
  if (prefilled) {
    ctx.session.data = { groupId };
    await runSingleAddressScan(ctx, groupId, prefilled);
    return;
  }

  ctx.session.data = { ...(ctx.session.data as object || {}), groupId };
  ctx.session.step = 'aw:addr';
  const cancelKb = new InlineKeyboard().text('← Отмена', `${P}:list`);
  const head = prefix ? `${prefix}\n\n` : '';
  const body =
    `${head}➕ *Добавить кошелёк*\n\n` +
    `Введите адрес кошелька \\(0x\\.\\.\\.\\)\\.\n` +
    `Для массового импорта Safe — несколько адресов через запятую без пробелов:`;
  try {
    await ctx.editMessageText(body, { parse_mode: 'MarkdownV2', reply_markup: cancelKb });
  } catch {
    await ctx.reply(body, { parse_mode: 'MarkdownV2', reply_markup: cancelKb });
  }
}

async function maybeAutoCreateDefaultGroup(ctx: BotContext): Promise<{ id: string; name: string } | null> {
  const chatId = config.telegram.adminUserId ?? ctx.from?.id;
  if (!chatId) return null;

  const existing = await prisma.client.findUnique({
    where: { telegramChatId: BigInt(chatId) },
    select: { id: true, name: true },
  });
  if (existing) return existing;

  const group = await prisma.client.create({
    data: {
      name: 'По умолчанию',
      telegramChatId: BigInt(chatId),
      tier: 'business',
    },
    select: { id: true, name: true },
  });

  await audit({
    action: 'client.create',
    actorId: ctx.from?.id,
    actorName: ctx.from?.username || ctx.from?.first_name,
    targetId: group.id,
    targetType: 'client',
    details: { name: group.name, telegramChatId: chatId, autoCreated: true },
  });

  logger.info({ groupId: group.id, chatId }, 'Auto-created default group');
  return group;
}

async function finishBulkAddWallet(ctx: BotContext): Promise<void> {
  const data = ctx.session.data as ScanSession | null;
  if (!data?.groupId || !data?.address) {
    await ctx.editMessageText('❌ Сессия истекла, начните сначала\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const { groupId, address, safeOn, allChainIds } = data;
  const isSafeMode = safeOn.length > 0;
  const targetChainIds = isSafeMode ? safeOn : allChainIds;
  const walletType: WalletType = isSafeMode ? 'safe' : 'eoa';
  const typeName = isSafeMode ? 'Safe' : 'EOA';

  const created: number[] = [];
  const skipped: number[] = [];
  const failed: number[] = [];

  for (const chainId of targetChainIds) {
    const net = NETWORKS.find(n => n.id === chainId);
    const walletName = `${typeName} ${net?.short || chainId} ${address.slice(0, 8)}...`;
    try {
      const existing = await prisma.wallet.findUnique({
        where: { address_chainId: { address, chainId } },
      });
      if (existing) {
        skipped.push(chainId);
        continue;
      }
      const wallet = await prisma.wallet.create({
        data: { clientId: groupId, address, chainId, type: walletType, name: walletName },
      });
      created.push(chainId);
      await audit({
        action: 'wallet.add',
        actorId: ctx.from?.id,
        actorName: ctx.from?.username || ctx.from?.first_name,
        targetId: wallet.id,
        targetType: 'wallet',
        details: { groupId, address, chainId, walletType, bulk: true },
      });
    } catch (err) {
      logger.error({ err, address, chainId }, 'Bulk wallet create failed');
      failed.push(chainId);
    }
  }

  ctx.session.step = undefined;
  ctx.session.data = undefined;

  const group = await prisma.client.findUnique({ where: { id: groupId }, select: { name: true } });

  const lines: string[] = [];
  if (created.length > 0) {
    lines.push(`✅ Добавлено: ${created.map(netName).join(', ')}`);
  }
  if (skipped.length > 0) {
    lines.push(`↪️ Уже существовали: ${skipped.map(netName).join(', ')}`);
  }
  if (failed.length > 0) {
    lines.push(`❌ Ошибка: ${failed.map(netName).join(', ')}`);
  }
  if (lines.length === 0) {
    lines.push('Ничего не добавлено\\.');
  }

  const summary =
    `*${typeName} кошелёк ×${created.length}*\n\n` +
    `\`${escapeMarkdown(address)}\`\n` +
    `Группа: ${escapeMarkdown(group?.name || '?')}\n\n` +
    lines.map(escapeMarkdown).join('\n');

  const kb = new InlineKeyboard()
    .text('➕ Ещё кошелёк', `${P}:add`)
    .text('← Кошельки', `${P}:list`);

  try {
    await ctx.editMessageText(summary, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } catch {
    await ctx.reply(summary, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }

  logger.info(
    { address, created: created.length, skipped: skipped.length, failed: failed.length, type: walletType },
    'Bulk wallet add completed',
  );
}

async function finishBatchAddSafe(ctx: BotContext): Promise<void> {
  const data = ctx.session.data as BatchScanSession | null;
  if (!data?.groupId || !Array.isArray(data?.results) || data.results.length === 0) {
    await ctx.editMessageText('❌ Сессия истекла, начните сначала\\.', { parse_mode: 'MarkdownV2' });
    return;
  }

  const { groupId, results } = data;

  let createdCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  const perAddress: Array<{ address: string; created: number[]; skipped: number[]; failed: number[] }> = [];

  for (const r of results) {
    const created: number[] = [];
    const skipped: number[] = [];
    const failed: number[] = [];

    for (const chainId of r.safeOn) {
      const net = NETWORKS.find(n => n.id === chainId);
      const walletName = `Safe ${net?.short || chainId} ${r.address.slice(0, 8)}...`;
      try {
        const existing = await prisma.wallet.findUnique({
          where: { address_chainId: { address: r.address, chainId } },
        });
        if (existing) {
          skipped.push(chainId);
          skippedCount++;
          continue;
        }
        const wallet = await prisma.wallet.create({
          data: { clientId: groupId, address: r.address, chainId, type: 'safe', name: walletName },
        });
        created.push(chainId);
        createdCount++;
        await audit({
          action: 'wallet.add',
          actorId: ctx.from?.id,
          actorName: ctx.from?.username || ctx.from?.first_name,
          targetId: wallet.id,
          targetType: 'wallet',
          details: { groupId, address: r.address, chainId, walletType: 'safe', batch: true },
        });
      } catch (err) {
        logger.error({ err, address: r.address, chainId }, 'Batch wallet create failed');
        failed.push(chainId);
        failedCount++;
      }
    }

    perAddress.push({ address: r.address, created, skipped, failed });
  }

  ctx.session.step = undefined;
  ctx.session.data = undefined;

  const group = await prisma.client.findUnique({ where: { id: groupId }, select: { name: true } });

  const lines: string[] = [];
  lines.push(`*Импорт Safe-кошельков завершён*`);
  lines.push('');
  lines.push(`Группа: ${escapeMarkdown(group?.name || '?')}`);
  lines.push(`Создано: *${createdCount}* · Пропущено: *${skippedCount}* · Ошибок: *${failedCount}*`);
  lines.push('');

  for (const a of perAddress.slice(0, 15)) {
    const short = `${a.address.slice(0, 8)}\\.\\.${a.address.slice(-4)}`;
    const parts: string[] = [];
    if (a.created.length > 0) parts.push(`✅ ${a.created.map(netName).join(', ')}`);
    if (a.skipped.length > 0) parts.push(`↪️ ${a.skipped.map(netName).join(', ')}`);
    if (a.failed.length > 0) parts.push(`❌ ${a.failed.map(netName).join(', ')}`);
    lines.push(`\`${short}\` ${escapeMarkdown(parts.join(' · '))}`);
  }
  if (perAddress.length > 15) {
    lines.push(`_и ещё ${perAddress.length - 15} адрес${pluralAdres(perAddress.length - 15)}\\.\\.\\._`);
  }

  const kb = new InlineKeyboard()
    .text('➕ Ещё', `${P}:add`)
    .text('← Кошельки', `${P}:list`);

  const body = lines.join('\n');
  try {
    await ctx.editMessageText(body, { parse_mode: 'MarkdownV2', reply_markup: kb });
  } catch {
    await ctx.reply(body, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }

  logger.info({ created: createdCount, skipped: skippedCount, failed: failedCount }, 'Batch wallet add completed');
}

async function finishAddWallet(ctx: BotContext, chainId: number): Promise<void> {
  const data = ctx.session.data as { groupId?: string; address?: string } | null;
  if (!data?.groupId || !data?.address) {
    await ctx.editMessageText('❌ Ошибка\\. Попробуйте снова\\.');
    return;
  }

  const { groupId, address } = data;

  try {
    const existing = await prisma.wallet.findUnique({
      where: { address_chainId: { address, chainId } },
    });
    if (existing) {
      const kb = new InlineKeyboard().text('← Кошельки', `${P}:list`);
      await ctx.editMessageText('❌ Этот кошелёк уже отслеживается в данной сети\\.', {
        parse_mode: 'MarkdownV2', reply_markup: kb,
      });
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return;
    }

    const walletType = await detectWalletType(address, chainId);
    const net = NETWORKS.find(n => n.id === chainId);
    const typeName = walletType === 'safe' ? 'Safe' : 'EOA';
    const walletName = `${typeName} ${net?.short || chainId} ${address.slice(0, 8)}...`;

    const wallet = await prisma.wallet.create({
      data: {
        clientId: groupId,
        address,
        chainId,
        type: walletType,
        name: walletName,
      },
    });

    const group = await prisma.client.findUnique({ where: { id: groupId }, select: { name: true } });

    await audit({
      action: 'wallet.add',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: wallet.id,
      targetType: 'wallet',
      details: { groupId, groupName: group?.name, address, chainId, walletType },
    });

    ctx.session.step = undefined;
    ctx.session.data = undefined;

    logger.info({ walletId: wallet.id, groupName: group?.name, address, chainId }, 'Wallet added');

    const kb = new InlineKeyboard()
      .text('➕ Ещё кошелёк', `${P}:add`)
      .text('← Кошельки', `${P}:list`);

    await ctx.editMessageText(
      `✅ *Кошелёк добавлен\\!*\n\n` +
      `\`${escapeMarkdown(address)}\`\n` +
      `Сеть: ${escapeMarkdown(net?.name || `Chain ${chainId}`)}\n` +
      `Тип: ${typeName}\n` +
      `Группа: ${escapeMarkdown(group?.name || '?')}`,
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  } catch {
    ctx.session.step = undefined;
    ctx.session.data = undefined;
    await ctx.editMessageText('❌ Ошибка\\. Возможно, кошелёк уже существует\\.');
  }
}

async function confirmRemove(ctx: BotContext, walletId: string): Promise<void> {
  const wallet = await prisma.wallet.findUnique({
    where: { id: walletId },
    include: { client: { select: { name: true } } },
  });
  if (!wallet) return;

  const net = NETWORKS.find(n => n.id === wallet.chainId);
  const kb = new InlineKeyboard()
    .text('Да, удалить', `${P}:rm_ok:${walletId}`)
    .text('Отмена', `${P}:list`);

  await ctx.editMessageText(
    `⚠️ *Удалить кошелёк?*\n\n\`${escapeMarkdown(wallet.address)}\`\n` +
    `${escapeMarkdown(net?.name || `Chain ${wallet.chainId}`)} \\| ${escapeMarkdown(wallet.client?.name || '?')}`,
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
      details: { address: wallet.address },
    });

    logger.info({ walletId, address: wallet.address }, 'Wallet removed');
    await showWalletList(ctx);
  } catch {
    await ctx.editMessageText('❌ Ошибка при удалении\\.');
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
