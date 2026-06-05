import { prisma } from '../../db/index.js';
import { redis, isRedisAvailable } from '../../db/redis.js';
import { createLogger } from '../../utils/logger.js';
import { escapeMarkdown } from '../../utils/formatters.js';
import { getBot } from '../telegram-bot/index.js';

const logger = createLogger('digest');

const DEDUP_KEY = 'digest:last_sent';
const DEDUP_TTL = 24 * 60 * 60;

export async function sendWeeklyDigests(): Promise<void> {
  const now = new Date();
  if (now.getUTCDay() !== 1 || now.getUTCHours() !== 9) {
    return;
  }

  if (isRedisAvailable()) {
    try {
      const result = await redis.set(DEDUP_KEY, now.toISOString(), 'EX', DEDUP_TTL, 'NX');
      if (result !== 'OK') {
        logger.debug('Weekly digest already sent this period');
        return;
      }
    } catch {
    }
  }

  const bot = getBot();
  if (!bot) {
    logger.error('Bot not initialized, cannot send digests');
    return;
  }

  try {
    const clients = await prisma.client.findMany({
      where: {
        wallets: { some: { isActive: true } },
      },
      include: {
        wallets: {
          where: { isActive: true },
          select: { id: true },
        },
      },
    });

    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    let sent = 0;

    for (const client of clients) {
      const walletIds = client.wallets.map(w => w.id);

      const [totalTx, riskBreakdown, statusBreakdown] = await Promise.all([
        prisma.transactionHistory.count({
          where: { walletId: { in: walletIds }, createdAt: { gte: weekAgo } },
        }),
        prisma.transactionHistory.groupBy({
          by: ['riskLevel'],
          where: { walletId: { in: walletIds }, createdAt: { gte: weekAgo } },
          _count: true,
        }),
        prisma.transactionHistory.groupBy({
          by: ['status'],
          where: { walletId: { in: walletIds }, createdAt: { gte: weekAgo } },
          _count: true,
        }),
      ]);

      if (totalTx === 0) continue;

      const riskMap = Object.fromEntries(riskBreakdown.map(r => [r.riskLevel || 'unknown', r._count]));
      const statusMap = Object.fromEntries(statusBreakdown.map(s => [s.status, s._count]));

      const weekStr = `${weekAgo.getUTCDate()}\\.${String(weekAgo.getUTCMonth() + 1).padStart(2, '0')} — ${now.getUTCDate()}\\.${String(now.getUTCMonth() + 1).padStart(2, '0')}`;

      const lines: string[] = [
        `📊 *Еженедельный отчёт*`,
        `_${weekStr}_`,
        '',
        `*Транзакции:* ${totalTx}`,
        `├ Выполнено: ${statusMap['executed'] || 0}`,
        `├ Pending: ${statusMap['pending'] || 0}`,
        `└ Отклонено/Failed: ${(statusMap['rejected'] || 0) + (statusMap['failed'] || 0)}`,
        '',
        `*Риски:*`,
        `├ ✅ OK: ${riskMap['ok'] || 0}`,
        `├ ⚠️ Warning: ${riskMap['warning'] || 0}`,
        `└ 🔴 Danger: ${riskMap['danger'] || 0}`,
        '',
        `👛 Кошельков: ${client.wallets.length}`,
        '',
        `_Transaction Guardian_`,
      ];

      try {
        await bot.api.sendMessage(Number(client.telegramChatId), lines.join('\n'), {
          parse_mode: 'MarkdownV2',
        });
        sent++;
      } catch (error) {
        logger.warn({ error, clientId: client.id }, 'Failed to send digest to client');
      }
    }

    logger.info({ sent, total: clients.length }, 'Weekly digests sent');
  } catch (error) {
    logger.error({ error }, 'Error sending weekly digests');
  }
}
