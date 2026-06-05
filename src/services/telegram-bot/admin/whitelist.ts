import { Bot, InlineKeyboard } from 'grammy';
import type { BotContext } from '../index.js';
import { checkIsAdmin } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';
import { validate, ethereumAddressSchema } from '../../../utils/validators.js';
import { audit } from '../../audit-log/index.js';
import { createLogger } from '../../../utils/logger.js';

const logger = createLogger('admin-whitelist');
const P = 'wl';

const CHAINS = [
  { id: 1, name: 'Ethereum', short: 'ETH' },
  { id: 42161, name: 'Arbitrum', short: 'ARB' },
  { id: 8453, name: 'Base', short: 'BASE' },
  { id: 137, name: 'Polygon', short: 'MATIC' },
  { id: 10, name: 'Optimism', short: 'OP' },
  { id: 56, name: 'BNB Chain', short: 'BNB' },
  { id: 43114, name: 'Avalanche', short: 'AVAX' },
];

const PROTOCOL_URLS: Record<string, string> = {
  '1inch': 'https://1inch.io',
  'Aave V3': 'https://aave.com',
  'Across': 'https://across.to',
  'Aerodrome': 'https://aerodrome.finance',
  'Aura Finance': 'https://aura.finance',
  'AURA Finance': 'https://aura.finance',
  'Balancer': 'https://balancer.fi',
  'Camelot': 'https://camelot.exchange',
  'Compound V3': 'https://compound.finance',
  'Convex': 'https://convexfinance.com',
  'CoW Protocol': 'https://cow.fi',
  'Curve': 'https://curve.fi',
  'EigenLayer': 'https://eigenlayer.xyz',
  'Ether.fi': 'https://ether.fi',
  'Fluid': 'https://fluid.instadapp.io',
  'FLUID': 'https://fluid.instadapp.io',
  'Gains Trade': 'https://gains.trade',
  'GMX': 'https://gmx.io',
  'Gnosis Bridge': 'https://bridge.gnosischain.com',
  'Hop Protocol': 'https://hop.exchange',
  'Jumper (LI.FI)': 'https://jumper.exchange',
  'KelpDAO': 'https://kelpdao.xyz',
  'KyberSwap': 'https://kyberswap.com',
  'Lido': 'https://lido.fi',
  'MakerDAO': 'https://makerdao.com',
  'Morpho': 'https://morpho.org',
  'Paraswap': 'https://paraswap.io',
  'Pendle': 'https://pendle.finance',
  'Stargate': 'https://stargate.finance',
  'Uniswap V3': 'https://uniswap.org',
  'Uniswap': 'https://uniswap.org',
  'Uniswap Universal Router': 'https://uniswap.org',
  '0x (Matcha)': 'https://matcha.xyz',
  'Velodrome': 'https://velodrome.finance',
  'PancakeSwap': 'https://pancakeswap.finance',
  'SushiSwap': 'https://sushi.com',
};

function protoDisplayName(name: string): string {
  const url = PROTOCOL_URLS[name];
  if (url) return `[${escapeMarkdown(name)}](${url})`;
  return escapeMarkdown(name);
}

export function setupWhitelistHandlers(bot: Bot<BotContext>): void {
  bot.command('whitelist', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;
    if (!await checkIsAdmin(ctx.from?.id)) return;
    await showMain(ctx);
  });

  bot.callbackQuery(new RegExp(`^${P}:`), async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) {
      await ctx.answerCallbackQuery('Нет доступа');
      return;
    }

    const parts = ctx.callbackQuery.data.split(':');
    const action = parts[1];

    switch (action) {
      case 'main': await showMain(ctx, true); break;
      case 'addrs': await showAddresses(ctx); break;
      case 'a_add': startAddAddress(ctx); break;
      case 'a_rm': await removeAddress(ctx, parts[2]); break;
      case 'protos': await showProtocols(ctx); break;
      case 'p': await showProtocol(ctx, parts[2]); break;
      case 'p_add': startAddProtocol(ctx); break;
      case 'p_ct': startAddContract(ctx, parts[2]); break;
      case 'p_ch': await addContract(ctx, parts[2], parseInt(parts[3])); break;
      case 'p_rm': await removeContract(ctx, parts[2], parts[3], parseInt(parts[4])); break;
    }

    await ctx.answerCallbackQuery();
  });

  bot.on('message:text', async (ctx, next) => {
    if (ctx.chat?.type !== 'private') return next();
    const step = ctx.session.step;
    if (!step?.startsWith('wl:')) return next();

    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return next();
    }

    if (step === 'wl:addr') {
      const result = validate(ethereumAddressSchema, text);
      if (!result.success) {
        await ctx.reply(`❌ ${escapeMarkdown(result.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }
      ctx.session.data = { address: result.data };
      ctx.session.step = 'wl:addr_label';
      const kb = new InlineKeyboard().text('Пропустить', `${P}:a_save`);
      await ctx.reply('Введите метку \\(имя\\) для адреса:', { parse_mode: 'MarkdownV2', reply_markup: kb });
    } else if (step === 'wl:addr_label') {
      await saveAddress(ctx, text);
    } else if (step === 'wl:proto_name') {
      await createProtocol(ctx, text);
    } else if (step.startsWith('wl:ct_addr:')) {
      const protoId = step.replace('wl:ct_addr:', '');
      const result = validate(ethereumAddressSchema, text);
      if (!result.success) {
        await ctx.reply(`❌ ${escapeMarkdown(result.error)}`, { parse_mode: 'MarkdownV2' });
        return;
      }
      ctx.session.data = { address: result.data };
      ctx.session.step = `wl:ct_chain:${protoId}`;

      const kb = new InlineKeyboard();
      for (let i = 0; i < CHAINS.length; i++) {
        kb.text(CHAINS[i].short, `${P}:p_ch:${protoId}:${CHAINS[i].id}`);
        if ((i + 1) % 4 === 0) kb.row();
      }
      kb.row().text('← Отмена', `${P}:p:${protoId}`);
      await ctx.reply(
        `Адрес: \`${escapeMarkdown(result.data.slice(0, 10))}\\.\\.\\.\`\n\nВыберите сеть:`,
        { parse_mode: 'MarkdownV2', reply_markup: kb }
      );
    }
  });

  bot.callbackQuery(`${P}:a_save`, async (ctx) => {
    if (!await checkIsAdmin(ctx.from?.id)) return;
    await ctx.answerCallbackQuery();
    await saveAddress(ctx, null);
  });
}

async function showMain(ctx: BotContext, edit = false): Promise<void> {
  const [protoCount, addrCount] = await Promise.all([
    prisma.protocolWhitelist.count({ where: { clientId: null, isActive: true } }),
    prisma.addressWhitelist.count({ where: { clientId: null, isActive: true } }),
  ]);

  const text = '✅ *Глобальный Whitelist*\n\nПрименяется ко всем клиентам';
  const kb = new InlineKeyboard()
    .text(`📋 Протоколы (${protoCount})`, `${P}:protos`).row()
    .text(`📍 Адреса (${addrCount})`, `${P}:addrs`).row()
    .text('← Назад', 'menu:back_admin');

  if (edit) {
    try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
    catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  } else {
    await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb });
  }
}

async function showAddresses(ctx: BotContext): Promise<void> {
  const addresses = await prisma.addressWhitelist.findMany({
    where: { clientId: null, isActive: true },
    orderBy: { label: 'asc' },
  });

  let text = `📍 *Адреса* \\(${addresses.length}\\)\n\n`;
  if (addresses.length === 0) {
    text += '_Пусто_\n';
  } else {
    for (const a of addresses) {
      const label = a.label || '';
      const short = `${a.address.slice(0, 6)}..${a.address.slice(-4)}`;
      text += `• \`${short}\` ${escapeMarkdown(label)}\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const a of addresses.slice(0, 8)) {
    const short = `${a.address.slice(0, 6)}..${a.address.slice(-4)}`;
    kb.text(`❌ ${short}`, `${P}:a_rm:${a.id}`).row();
  }
  kb.text('➕ Добавить адрес', `${P}:a_add`).row();
  kb.text('← Назад', `${P}:main`);

  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function startAddAddress(ctx: BotContext): Promise<void> {
  ctx.session.step = 'wl:addr';
  ctx.session.data = undefined;
  const kb = new InlineKeyboard().text('← Отмена', `${P}:addrs`);
  const text = '➕ *Добавить адрес*\n\nВведите адрес \\(0x\\.\\.\\.\\):';
  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function saveAddress(ctx: BotContext, label: string | null): Promise<void> {
  const address = (ctx.session.data as { address?: string })?.address;
  if (!address) {
    ctx.session.step = undefined;
    return;
  }

  try {
    await prisma.addressWhitelist.create({
      data: { address, label: label || null, isActive: true },
    });

    await audit({
      action: 'whitelist.address_add',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetType: 'address_whitelist',
      details: { address, label },
    });

    ctx.session.step = undefined;
    ctx.session.data = undefined;
    logger.info({ address, label }, 'Address added to whitelist');

    const kb = new InlineKeyboard().text('← Адреса', `${P}:addrs`);
    await ctx.reply(
      `✅ Адрес добавлен\\!\n\n\`${escapeMarkdown(address)}\`${label ? `\n${escapeMarkdown(label)}` : ''}`,
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  } catch {
    ctx.session.step = undefined;
    ctx.session.data = undefined;
    await ctx.reply('❌ Ошибка\\. Возможно, адрес уже в whitelist\\.');
  }
}

async function removeAddress(ctx: BotContext, id: string): Promise<void> {
  try {
    const addr = await prisma.addressWhitelist.update({
      where: { id }, data: { isActive: false },
    });

    await audit({
      action: 'whitelist.address_remove',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: id,
      targetType: 'address_whitelist',
      details: { address: addr.address },
    });

    logger.info({ id, address: addr.address }, 'Address removed from whitelist');
    await showAddresses(ctx);
  } catch {
    await ctx.editMessageText('❌ Ошибка при удалении\\.');
  }
}

async function showProtocols(ctx: BotContext): Promise<void> {
  const protocols = await prisma.protocolWhitelist.findMany({
    where: { clientId: null, isActive: true },
    orderBy: { protocolName: 'asc' },
  });

  let text = `📋 *Протоколы* \\(${protocols.length}\\)\n\n`;
  if (protocols.length === 0) {
    text += '_Пусто_\n';
  } else {
    for (const p of protocols) {
      const addrs = p.contractAddresses as Record<string, string[]>;
      const total = Object.values(addrs).reduce((s, a) => s + a.length, 0);
      text += `• ${protoDisplayName(p.protocolName)} \\(${total}\\)\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const p of protocols.slice(0, 10)) {
    const addrs = p.contractAddresses as Record<string, string[]>;
    const total = Object.values(addrs).reduce((s, a) => s + a.length, 0);
    kb.text(`${p.protocolName} (${total})`, `${P}:p:${p.id}`).row();
  }
  kb.text('➕ Новый протокол', `${P}:p_add`).row();
  kb.text('← Назад', `${P}:main`);

  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function showProtocol(ctx: BotContext, protoId: string): Promise<void> {
  const proto = await prisma.protocolWhitelist.findUnique({ where: { id: protoId } });
  if (!proto) return;

  const addrs = proto.contractAddresses as Record<string, string[]>;
  const url = PROTOCOL_URLS[proto.protocolName];
  const nameDisplay = url
    ? `[${escapeMarkdown(proto.protocolName)}](${url})`
    : escapeMarkdown(proto.protocolName);
  let text = `📋 *${nameDisplay}*\n\n`;

  const chainEntries = Object.entries(addrs).filter(([, a]) => a.length > 0);
  if (chainEntries.length === 0) {
    text += '_Контрактов нет_\n';
  } else {
    for (const [chainId, contracts] of chainEntries) {
      const chain = CHAINS.find(c => c.id === parseInt(chainId));
      text += `*${escapeMarkdown(chain?.name || `Chain ${chainId}`)}:*\n`;
      for (const addr of contracts) {
        text += `\`${escapeMarkdown(addr)}\`\n`;
      }
      text += '\n';
    }
  }

  const kb = new InlineKeyboard();
  kb.text('➕ Добавить контракт', `${P}:p_ct:${protoId}`).row();
  kb.text('← Протоколы', `${P}:protos`);

  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function startAddProtocol(ctx: BotContext): Promise<void> {
  ctx.session.step = 'wl:proto_name';
  ctx.session.data = undefined;
  const kb = new InlineKeyboard().text('← Отмена', `${P}:protos`);
  const text = '➕ *Новый протокол*\n\nВведите название:';
  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function createProtocol(ctx: BotContext, name: string): Promise<void> {
  try {
    const proto = await prisma.protocolWhitelist.create({
      data: {
        protocolName: name,
        contractAddresses: {},
        isActive: true,
      },
    });

    await audit({
      action: 'whitelist.protocol_add',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: proto.id,
      targetType: 'protocol_whitelist',
      details: { name },
    });

    ctx.session.step = undefined;
    logger.info({ protoId: proto.id, name }, 'Protocol created');

    const kb = new InlineKeyboard()
      .text('➕ Добавить контракт', `${P}:p_ct:${proto.id}`).row()
      .text('← Протоколы', `${P}:protos`);

    await ctx.reply(
      `✅ Протокол *${escapeMarkdown(name)}* создан\\!`,
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  } catch {
    ctx.session.step = undefined;
    await ctx.reply('❌ Ошибка\\. Возможно, протокол уже существует\\.');
  }
}

async function startAddContract(ctx: BotContext, protoId: string): Promise<void> {
  ctx.session.step = `wl:ct_addr:${protoId}`;
  ctx.session.data = undefined;
  const kb = new InlineKeyboard().text('← Отмена', `${P}:p:${protoId}`);
  const text = '➕ *Добавить контракт*\n\nВведите адрес контракта \\(0x\\.\\.\\.\\):';
  try { await ctx.editMessageText(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
  catch { await ctx.reply(text, { parse_mode: 'MarkdownV2', reply_markup: kb }); }
}

async function addContract(ctx: BotContext, protoId: string, chainId: number): Promise<void> {
  const address = (ctx.session.data as { address?: string })?.address;
  if (!address) {
    await ctx.editMessageText('❌ Ошибка\\. Попробуйте снова\\.');
    return;
  }

  try {
    const proto = await prisma.protocolWhitelist.findUnique({ where: { id: protoId } });
    if (!proto) return;

    const addrs = proto.contractAddresses as Record<string, string[]>;
    const chainKey = chainId.toString();
    if (!addrs[chainKey]) addrs[chainKey] = [];

    if (addrs[chainKey].some(a => a.toLowerCase() === address.toLowerCase())) {
      const kb = new InlineKeyboard().text('← Назад', `${P}:p:${protoId}`);
      await ctx.editMessageText('❌ Этот контракт уже в whitelist для данной сети\\.', {
        parse_mode: 'MarkdownV2', reply_markup: kb,
      });
      ctx.session.step = undefined;
      ctx.session.data = undefined;
      return;
    }

    addrs[chainKey].push(address);
    await prisma.protocolWhitelist.update({
      where: { id: protoId },
      data: { contractAddresses: addrs },
    });

    await audit({
      action: 'whitelist.contract_add',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: protoId,
      targetType: 'protocol_whitelist',
      details: { protocol: proto.protocolName, address, chainId },
    });

    ctx.session.step = undefined;
    ctx.session.data = undefined;

    const chain = CHAINS.find(c => c.id === chainId);
    logger.info({ protoId, protocol: proto.protocolName, address, chainId }, 'Contract added to whitelist');

    const kb = new InlineKeyboard()
      .text('➕ Ещё контракт', `${P}:p_ct:${protoId}`)
      .text('← Протокол', `${P}:p:${protoId}`);

    await ctx.editMessageText(
      `✅ *Контракт добавлен\\!*\n\n` +
      `Протокол: ${escapeMarkdown(proto.protocolName)}\n` +
      `Сеть: ${escapeMarkdown(chain?.name || `Chain ${chainId}`)}\n` +
      `\`${escapeMarkdown(address)}\``,
      { parse_mode: 'MarkdownV2', reply_markup: kb }
    );
  } catch {
    ctx.session.step = undefined;
    ctx.session.data = undefined;
    await ctx.editMessageText('❌ Ошибка при добавлении\\.');
  }
}

async function removeContract(ctx: BotContext, protoId: string, address: string, chainId: number): Promise<void> {
  try {
    const proto = await prisma.protocolWhitelist.findUnique({ where: { id: protoId } });
    if (!proto) return;

    const addrs = proto.contractAddresses as Record<string, string[]>;
    const chainKey = chainId.toString();
    if (addrs[chainKey]) {
      addrs[chainKey] = addrs[chainKey].filter(a => a.toLowerCase() !== address.toLowerCase());
    }

    await prisma.protocolWhitelist.update({
      where: { id: protoId },
      data: { contractAddresses: addrs },
    });

    await audit({
      action: 'whitelist.contract_remove',
      actorId: ctx.from?.id,
      actorName: ctx.from?.username || ctx.from?.first_name,
      targetId: protoId,
      targetType: 'protocol_whitelist',
      details: { protocol: proto.protocolName, address, chainId },
    });

    logger.info({ protoId, address, chainId }, 'Contract removed from whitelist');
    await showProtocol(ctx, protoId);
  } catch {
    await ctx.editMessageText('❌ Ошибка при удалении\\.');
  }
}
