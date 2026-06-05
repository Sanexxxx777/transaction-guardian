import { prisma } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';

const logger = createLogger('audit-log');

export type AuditAction =
  | 'client.create'
  | 'client.delete'
  | 'wallet.add'
  | 'wallet.remove'
  | 'wallet.toggle'
  | 'policy.update'
  | 'whitelist.add'
  | 'whitelist.remove'
  | 'whitelist.address_add'
  | 'whitelist.address_remove'
  | 'whitelist.protocol_add'
  | 'whitelist.contract_add'
  | 'whitelist.contract_remove'
  | 'blacklist.add'
  | 'network.toggle'
  | 'admin.add'
  | 'admin.remove'
  | 'subscription.activate'
  | 'allowed_user.add'
  | 'allowed_user.remove'
  | 'manual_analyze';

interface AuditLogEntry {
  action: AuditAction;
  actorId?: string | number | bigint;
  actorName?: string;
  targetId?: string;
  targetType?: string;
  details?: Record<string, unknown>;
}

export async function audit(entry: AuditLogEntry): Promise<void> {
  try {
    await prisma.auditLog.create({
      data: {
        action: entry.action,
        actorId: entry.actorId?.toString() ?? null,
        actorName: entry.actorName ?? null,
        targetId: entry.targetId ?? null,
        targetType: entry.targetType ?? null,
        details: (entry.details as object) ?? undefined,
      },
    });
  } catch (error) {
    logger.error({ error, entry }, 'Failed to write audit log');
  }
}

export async function getRecentAuditLogs(limit = 20): Promise<Array<{
  action: string;
  actorName: string | null;
  targetType: string | null;
  details: unknown;
  createdAt: Date;
}>> {
  return prisma.auditLog.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      action: true,
      actorName: true,
      targetType: true,
      details: true,
      createdAt: true,
    },
  });
}
