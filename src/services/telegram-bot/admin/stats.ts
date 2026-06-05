import { Bot } from 'grammy';
import type { BotContext } from '../index.js';
import { prisma } from '../../../db/index.js';

export function setupStatsHandlers(bot: Bot<BotContext>): void {
  bot.command('stats', async (ctx) => {
    if (ctx.chat?.type !== 'private') return;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [
      clientsCount,
      walletsCount,
      totalTx,
      executedTx,
      rejectedTx,
      failedTx,
      pendingTx,
      txByRisk,
    ] = await Promise.all([
      prisma.client.count(),
      prisma.wallet.count({ where: { isActive: true } }),
      prisma.transactionHistory.count({ where: { createdAt: { gte: sevenDaysAgo } } }),
      prisma.transactionHistory.count({ where: { status: 'executed', createdAt: { gte: sevenDaysAgo } } }),
      prisma.transactionHistory.count({ where: { status: 'rejected', createdAt: { gte: sevenDaysAgo } } }),
      prisma.transactionHistory.count({ where: { status: 'failed', createdAt: { gte: sevenDaysAgo } } }),
      prisma.transactionHistory.count({ where: { status: 'pending' } }),
      prisma.transactionHistory.groupBy({
        by: ['riskLevel'],
        where: { createdAt: { gte: sevenDaysAgo } },
        _count: true,
      }),
    ]);

    const riskCounts: Record<string, number> = {
      ok: 0,
      warning: 0,
      danger: 0,
    };
    for (const r of txByRisk) {
      if (r.riskLevel) {
        riskCounts[r.riskLevel] = r._count;
      }
    }

    const text = `📊 *Статистика*

Клиенты: ${clientsCount}
Кошельков: ${walletsCount}

*Транзакции за 7 дней:*
├── Всего: ${totalTx}
├── ✅ Executed: ${executedTx}
├── 🚫 Rejected: ${rejectedTx}
├── ❌ Failed: ${failedTx}
└── ⏳ Pending: ${pendingTx}

*По уровню риска:*
├── 🟢 OK: ${riskCounts.ok}
├── 🟡 Warning: ${riskCounts.warning}
└── 🔴 Danger: ${riskCounts.danger}`;

    await ctx.reply(text, { parse_mode: 'Markdown' });
  });
}
