import { prisma } from '../../../db/index.js';
import { config } from '../../../config/index.js';
import { createLogger } from '../../../utils/logger.js';
import { addressEquals } from '../../../utils/address.js';
import { isAddressWhitelisted } from '../whitelist.js';
import { getSafeApiClient } from '../../wallet-monitor/safe-api.js';
import type { PolicyViolation, PolicyCheckInput } from '../../../models/policy.js';

const logger = createLogger('safe-admin-check');

interface SafeOnChainState {
  ownerCount: number;
  threshold: number;
}

async function getSafeState(chainId: number, safeAddress: string): Promise<SafeOnChainState | null> {
  try {
    const network = await prisma.network.findUnique({
      where: { chainId },
      select: { safeTxServiceUrl: true },
    });
    if (!network) return null;
    const client = getSafeApiClient(chainId, network.safeTxServiceUrl, config.safe.apiKey || undefined);
    const info = await client.getSafeInfo(safeAddress);
    if (!info) return null;
    return {
      ownerCount: Array.isArray(info.owners) ? info.owners.length : 0,
      threshold: typeof info.threshold === 'number' ? info.threshold : 0,
    };
  } catch (err) {
    logger.warn({ err, chainId, safeAddress }, 'Could not fetch Safe state for self-management risk check');
    return null;
  }
}

export async function checkSafeAdmin(input: PolicyCheckInput): Promise<PolicyViolation[]> {
  if (!addressEquals(input.transaction.to, input.transaction.from)) return [];

  const params = input.decodedParams as { method?: string } & Record<string, unknown> | undefined;
  if (!params?.method) return [];

  const violations: PolicyViolation[] = [];
  const state = await getSafeState(input.transaction.chainId, input.transaction.from);

  switch (params.method) {
    case 'changeThreshold': {
      const newT = Number(params.threshold);
      const oldT = state?.threshold;
      const owners = state?.ownerCount;

      if (newT === 1 && (owners ?? 2) > 1) {
        violations.push({
          ruleId: 'SAFE_THRESHOLD_SINGLE_SIG',
          severity: 'danger',
          title: 'Порог снижается до 1 подписи',
          description: oldT
            ? `Был ${oldT} из ${owners ?? '?'}, станет 1 из ${owners ?? '?'} — одной скомпрометированной подписи будет достаточно для любой транзакции\\.`
            : `Станет 1 — одной скомпрометированной подписи будет достаточно для любой транзакции\\.`,
          details: { oldThreshold: oldT, newThreshold: newT, ownerCount: owners },
        });
      } else if (oldT !== undefined && newT < oldT) {
        violations.push({
          ruleId: 'SAFE_THRESHOLD_LOWERED',
          severity: 'warning',
          title: 'Порог подписей снижается',
          description: `Был ${oldT} из ${owners ?? '?'}, станет ${newT} из ${owners ?? '?'} — требуется меньше подписей для исполнения транзакций.`,
          details: { oldThreshold: oldT, newThreshold: newT, ownerCount: owners },
        });
      } else if (oldT !== undefined && newT > oldT) {
        violations.push({
          ruleId: 'SAFE_THRESHOLD_RAISED',
          severity: 'info',
          title: 'Порог подписей повышается',
          description: `Был ${oldT}, станет ${newT}.`,
          details: { oldThreshold: oldT, newThreshold: newT, ownerCount: owners },
        });
      }
      break;
    }

    case 'addOwnerWithThreshold': {
      const owner = String(params.owner);
      const newT = Number(params.threshold);
      const wl = isAddressWhitelisted(owner, input.transaction.chainId, input.effectiveWhitelists);
      const ownersAfter = (state?.ownerCount ?? 0) + 1;

      if (newT === 1 && ownersAfter > 1) {
        violations.push({
          ruleId: 'SAFE_THRESHOLD_SINGLE_SIG',
          severity: 'danger',
          title: 'Порог станет 1 подпись',
          description: `Добавляется владелец и одновременно порог ставится в 1 — любой из ${ownersAfter} подписантов сможет действовать без согласования.`,
          details: { newThreshold: newT, ownerCountAfter: ownersAfter, owner },
        });
      }

      violations.push({
        ruleId: 'SAFE_OWNER_ADDED',
        severity: wl.whitelisted ? 'info' : 'warning',
        title: wl.whitelisted
          ? `Добавляется доверенный владелец${wl.label ? ` (${wl.label})` : ''}`
          : 'Добавляется новый владелец',
        description: wl.whitelisted
          ? `Адрес ${owner} есть в whitelist, новый порог ${newT} из ${ownersAfter}.`
          : `Адрес ${owner} получает право подписи. Убедитесь, что это доверенный человек/контракт. Новый порог: ${newT} из ${ownersAfter}.`,
        details: { owner, threshold: newT, whitelisted: wl.whitelisted, ownerCountAfter: ownersAfter },
      });
      break;
    }

    case 'removeOwner': {
      const owner = String(params.owner);
      const newT = Number(params.threshold);
      const ownersAfter = Math.max(0, (state?.ownerCount ?? 1) - 1);

      if (newT === 1 && ownersAfter > 1) {
        violations.push({
          ruleId: 'SAFE_THRESHOLD_SINGLE_SIG',
          severity: 'danger',
          title: 'Порог станет 1 подпись',
          description: `После удаления владельца порог станет 1 из ${ownersAfter} — одной подписи будет достаточно для любой транзакции.`,
          details: { newThreshold: newT, ownerCountAfter: ownersAfter, owner },
        });
      }

      violations.push({
        ruleId: 'SAFE_OWNER_REMOVED',
        severity: 'warning',
        title: 'Удаляется владелец',
        description: `Адрес ${owner} теряет право подписи. Новый порог: ${newT} из ${ownersAfter}.`,
        details: { owner, threshold: newT, ownerCountAfter: ownersAfter },
      });
      break;
    }

    case 'swapOwner': {
      const oldOwner = String(params.oldOwner);
      const newOwner = String(params.newOwner);
      const wl = isAddressWhitelisted(newOwner, input.transaction.chainId, input.effectiveWhitelists);
      violations.push({
        ruleId: 'SAFE_OWNER_SWAPPED',
        severity: wl.whitelisted ? 'info' : 'warning',
        title: wl.whitelisted
          ? `Заменяется владелец на доверенного${wl.label ? ` (${wl.label})` : ''}`
          : 'Заменяется владелец',
        description: wl.whitelisted
          ? `Старый: ${oldOwner}; новый: ${newOwner} (в whitelist).`
          : `Старый: ${oldOwner}; новый: ${newOwner}. Проверьте личность нового владельца.`,
        details: { oldOwner, newOwner, whitelisted: wl.whitelisted },
      });
      break;
    }

    case 'enableModule': {
      const module = String(params.module);
      const wl = isAddressWhitelisted(module, input.transaction.chainId, input.effectiveWhitelists);
      violations.push({
        ruleId: 'SAFE_MODULE_ENABLED',
        severity: wl.whitelisted ? 'warning' : 'danger',
        title: wl.whitelisted
          ? `Включается известный модуль${wl.label ? ` (${wl.label})` : ''}`
          : 'Включается модуль (исполнение в обход подписей)',
        description: wl.whitelisted
          ? `Модуль ${module} есть в whitelist. После включения он сможет исполнять транзакции без подписей владельцев.`
          : `Модуль ${module} получит право исполнять транзакции БЕЗ подписей владельцев. Убедитесь, что это доверенный контракт.`,
        details: { module, whitelisted: wl.whitelisted },
      });
      break;
    }

    case 'disableModule': {
      const module = String(params.module);
      violations.push({
        ruleId: 'SAFE_MODULE_DISABLED',
        severity: 'info',
        title: 'Отключается модуль',
        description: `Модуль ${module} больше не сможет исполнять транзакции.`,
        details: { module },
      });
      break;
    }

    case 'setGuard': {
      const guard = String(params.guard);
      const isReset = /^0x0+$/.test(guard);
      if (isReset) {
        violations.push({
          ruleId: 'SAFE_GUARD_REMOVED',
          severity: 'info',
          title: 'Снимается guard',
          description: 'Дополнительный контроль перед/после транзакций больше не применяется.',
          details: { guard },
        });
      } else {
        const wl = isAddressWhitelisted(guard, input.transaction.chainId, input.effectiveWhitelists);
        violations.push({
          ruleId: 'SAFE_GUARD_SET',
          severity: wl.whitelisted ? 'warning' : 'danger',
          title: wl.whitelisted
            ? `Устанавливается известный guard${wl.label ? ` (${wl.label})` : ''}`
            : 'Устанавливается guard (может блокировать транзакции)',
          description: wl.whitelisted
            ? `Guard ${guard} в whitelist. Он будет проверять каждую транзакцию.`
            : `Guard ${guard} будет вызываться до и после каждой транзакции и может её отклонить. Убедитесь, что это доверенный контракт.`,
          details: { guard, whitelisted: wl.whitelisted },
        });
      }
      break;
    }

    case 'approveHash':
      break;

    default:

      violations.push({
        ruleId: 'SAFE_OWNER_SWAPPED',
        severity: 'info',
        title: 'Операция управления Safe',
        description: `Метод: ${String(params.method)}. Неизвестная операция управления — проверьте вручную.`,
      });
  }

  return violations;
}
