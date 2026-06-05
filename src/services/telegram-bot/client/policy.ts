import { Bot } from 'grammy';
import type { BotContext } from '../index.js';
import { getClientByChatId } from '../index.js';
import { prisma } from '../../../db/index.js';
import { escapeMarkdown } from '../../../utils/formatters.js';

export function setupPolicyHandler(bot: Bot<BotContext>): void {
  bot.command('policy', async (ctx) => {
    if (ctx.chat?.type === 'private') return;

    const client = await getClientByChatId(ctx.chat.id);
    if (!client) {
      await ctx.reply('⚠️ Этот чат не привязан к клиенту\\.');
      return;
    }

    const policy = await prisma.policy.findUnique({
      where: { clientId: client.id },
    });

    const [globalProtocols, clientProtocols, globalAddresses, clientAddresses] = await Promise.all([
      prisma.protocolWhitelist.count({ where: { clientId: null, isActive: true } }),
      prisma.protocolWhitelist.count({ where: { clientId: client.id, isActive: true } }),
      prisma.addressWhitelist.count({ where: { clientId: null, isActive: true } }),
      prisma.addressWhitelist.count({ where: { clientId: client.id, isActive: true } }),
    ]);

    const maxTx = policy?.maxTransactionUsd ? `\\$${escapeMarkdown(policy.maxTransactionUsd.toString())}` : 'не задан';
    const dailyLimit = policy?.dailyLimitUsd ? `\\$${escapeMarkdown(policy.dailyLimitUsd.toString())}` : 'не задан';
    const maxApproval = policy?.maxApprovalUsd ? `\\$${escapeMarkdown(policy.maxApprovalUsd.toString())}` : 'не задан';
    const unlimited = policy?.blockUnlimitedApprovals ? '🚫 Заблокированы' : '⚠️ Разрешены';
    const unknown = policy?.blockUnknownContracts ? '🚫 Заблокированы' : '⚠️ Разрешены';

    const text = `⚙️ *Текущие настройки политик*

*Лимиты:*
├── Макс\\. транзакция: ${maxTx}
├── Дневной лимит: ${dailyLimit}
└── Макс\\. approval: ${maxApproval}

*Проверки:*
├── Unlimited approvals: ${unlimited}
└── Неизвестные контракты: ${unknown}

*Whitelist протоколов:* ${globalProtocols} \\(глобальный\\) \\+ ${clientProtocols} \\(ваш\\)
*Whitelist адресов:* ${globalAddresses} \\(глобальный\\) \\+ ${clientAddresses} \\(ваш\\)

_Для изменения настроек обратитесь к администратору_`;

    await ctx.reply(text, { parse_mode: 'MarkdownV2' });
  });
}
