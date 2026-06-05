import { prisma } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { getEffectiveWhitelists, isProtocolWhitelisted } from './whitelist.js';
import { checkAmountLimits } from './rules/amount-limits.js';
import { checkApprovals } from './rules/approvals.js';
import { checkProtocol, checkContractUpgrade } from './rules/protocol-check.js';
import { checkRecipient } from './rules/recipient-check.js';
import { checkBlacklist } from './rules/blacklist.js';
import { checkContract } from './rules/contract-check.js';
import { checkAmountAnomaly, checkSimilarAddresses } from './rules/anomaly-check.js';
import {
  checkCowCustomReceiver,
  checkCowApproveMismatch,
  checkCowOrderStatus,
  checkCowPriceSanity,
} from './rules/cow-checks.js';
import { checkSafeAdmin } from './rules/safe-admin.js';

function translateError(error: string | undefined): string | undefined {
  if (!error) return error;

  const safeErrors: Record<string, string> = {
    GS013: 'Подтверждение не удалось — возможно, мало подписей или хэш не совпадает',
    GS020: 'Не хватает подписей — наберите ещё подписи владельцев',
    GS021: 'Подпись недействительна или не от владельца',
    GS022: 'Неверный формат подписи',
    GS023: 'Подпись от адреса, не являющегося владельцем',
    GS024: 'Контрактная подпись недействительна',
    GS025: 'Hash approval не найден',
    GS026: 'Недостаточно подтверждённых подписей',
    GS030: 'Указанный владелец не найден в списке Safe',
    GS031: 'Только сам Safe может вызывать эту функцию (или нарушен порядок prevOwner в списке)',
    GS032: 'Новый порог больше количества владельцев',
    GS033: 'Порог должен быть больше нуля',
  };
  const safeMatch = error.match(/GS0\d{2}/);
  if (safeMatch && safeErrors[safeMatch[0]]) {
    return `${safeMatch[0]}: ${safeErrors[safeMatch[0]]}`;
  }
  const map: Array<[RegExp, string]> = [
    [/insufficient balance for transfer/i, 'Недостаточный баланс для перевода'],
    [/insufficient funds/i, 'Недостаточно средств'],
    [/execution reverted/i, 'Транзакция отменена контрактом'],
    [/out of gas/i, 'Недостаточно газа'],
    [/transfer amount exceeds balance/i, 'Сумма перевода превышает баланс'],
    [/transfer amount exceeds allowance/i, 'Сумма превышает разрешение (allowance)'],
  ];
  for (const [pattern, translation] of map) {
    if (pattern.test(error)) return translation;
  }
  return error;
}
import type {
  PolicyCheckInput,
  PolicyCheckResult,
  PolicyViolation,
  ClientPolicy,
} from '../../models/policy.js';
import type { ProcessedTransaction, SimulationResult, RiskLevel } from '../../models/transaction.js';

const logger = createLogger('policy-engine');

export { getEffectiveWhitelists } from './whitelist.js';

export async function checkPolicies(
  transaction: ProcessedTransaction,
  clientId: string,
  simulationResult?: SimulationResult
): Promise<PolicyCheckResult> {
  const txId = transaction.safeTxHash || transaction.txHash;
  logger.info(
    { txId, clientId },
    'Running policy checks'
  );

  const policy = await prisma.policy.findUnique({
    where: { clientId },
  });

  const effectiveWhitelists = await getEffectiveWhitelists(clientId);

  const dailySpentUsd = await calculateDailySpent(clientId);

  const input: PolicyCheckInput = {
    transaction: {
      from: transaction.walletAddress,
      to: transaction.to,
      value: transaction.value,
      data: transaction.data,
      chainId: transaction.chainId,
    },
    simulationResult: simulationResult
      ? {
          success: simulationResult.success,
          assetChanges: simulationResult.assetChanges,
        }
      : undefined,
    clientPolicy: policy
      ? {
          id: policy.id,
          clientId: policy.clientId,
          maxTransactionUsd: policy.maxTransactionUsd?.toString() || null,
          dailyLimitUsd: policy.dailyLimitUsd?.toString() || null,
          blockUnlimitedApprovals: policy.blockUnlimitedApprovals,
          maxApprovalUsd: policy.maxApprovalUsd?.toString() || null,
          warnUnknownContracts: policy.warnUnknownContracts,
          blockUnknownContracts: policy.blockUnknownContracts,
        }
      : null,
    effectiveWhitelists,
    decodedMethod: transaction.decodedMethod,
    decodedParams: transaction.decodedParams as Record<string, unknown>,
    detectedRecipient: transaction.detectedRecipient,
    detectedProtocol: transaction.detectedProtocol,
    dailySpentUsd,
    clientId,
    cowOrders: transaction.cowOrders,
  };

  const violations: PolicyViolation[] = [];

  if (input.transaction.to.toLowerCase() === input.transaction.from.toLowerCase()) {
    const adminViolations = await checkSafeAdmin(input);
    const riskLevel = calculateRiskLevel(adminViolations);
    logger.info(
      { txId, method: input.decodedMethod, violations: adminViolations.length, riskLevel },
      'Safe self-management transaction analyzed',
    );
    return { riskLevel, violations: adminViolations };
  }

  if (simulationResult && !simulationResult.success) {
    const errorMsg = simulationResult.error?.toLowerCase() || '';
    const isServiceError = errorMsg.includes('internal server error')
      || errorMsg.includes('timeout')
      || errorMsg.includes('unavailable')
      || errorMsg.includes('bad gateway')
      || errorMsg.includes('service error');

    const decodedLower = (input.decodedMethod || '').toLowerCase();
    const isCowRevert = errorMsg.includes('gpv2')
      || errorMsg.includes('presign')
      || errorMsg.includes('cannot presign')
      || decodedLower.includes('setpresignature')
      || decodedLower.includes('cow');

    const protocolCheck = isProtocolWhitelisted(input.transaction.to, input.transaction.chainId, effectiveWhitelists);
    const detectedProtoLower = (input.detectedProtocol || '').toLowerCase();
    const isMultiSendOrSafeAdmin = detectedProtoLower.includes('multisend')
      || detectedProtoLower.startsWith('safe');
    const isSwapRevert = !isMultiSendOrSafeAdmin
      && (protocolCheck.whitelisted || !!input.detectedProtocol);

    if (isCowRevert) {
      logger.info({ txId, error: simulationResult.error }, 'CoW Protocol expected simulation revert — ignoring');
    } else {
      violations.push({
        ruleId: 'SIMULATION_FAILED',
        severity: (isServiceError || isSwapRevert) ? 'warning' : 'danger',
        title: isSwapRevert ? 'Симуляция не прошла' : 'Транзакция не пройдёт',
        description: isServiceError
          ? `Сервис симуляции временно недоступен — проверьте транзакцию вручную`
          : isSwapRevert
            ? 'Возможно, истёк срок действия котировки — попробуйте создать транзакцию заново'
            : translateError(simulationResult.error) || 'Транзакция не будет выполнена успешно',
        details: { error: simulationResult.error },
      });
    }
  }

  violations.push(...checkProtocol(input));

  violations.push(...checkAmountLimits(input));

  violations.push(...(await checkApprovals(input)));

  violations.push(...(await checkRecipient(input)));

  violations.push(...checkContractUpgrade(input));

  violations.push(...(await checkBlacklist(input)));

  violations.push(...(await checkSimilarAddresses(input)));

  violations.push(...(await checkContract(input)));

  violations.push(...(await checkAmountAnomaly(input)));

  violations.push(...checkCowCustomReceiver(input));

  violations.push(...checkCowApproveMismatch(input));

  violations.push(...checkCowOrderStatus(input));

  violations.push(...(await checkCowPriceSanity(input)));

  if (!input.decodedMethod && input.transaction.data && input.transaction.data !== '0x' && input.transaction.data.length >= 10) {
    violations.push({
      ruleId: 'UNKNOWN_METHOD',
      severity: 'warning',
      title: 'Неизвестный метод',
      description: `Селектор ${input.transaction.data.slice(0, 10)} не удалось декодировать`,
      details: { selector: input.transaction.data.slice(0, 10) },
    });
  }

  const riskLevel = calculateRiskLevel(violations);

  logger.info(
    {
      txId,
      riskLevel,
      violationsCount: violations.length,
      dangerCount: violations.filter((v) => v.severity === 'danger').length,
      warningCount: violations.filter((v) => v.severity === 'warning').length,
    },
    'Policy check completed'
  );

  return { riskLevel, violations };
}

function calculateRiskLevel(violations: PolicyViolation[]): RiskLevel {
  if (violations.some((v) => v.severity === 'danger')) {
    return 'danger';
  }
  if (violations.some((v) => v.severity === 'warning')) {
    return 'warning';
  }
  if (violations.some((v) => v.severity === 'info')) {
    return 'info';
  }
  return 'ok';
}

async function calculateDailySpent(clientId: string): Promise<number> {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

  const transactions = await prisma.transactionHistory.findMany({
    where: {
      wallet: { clientId },
      status: 'executed',
      executedAt: { gte: oneDayAgo },
    },
    select: {
      simulationResult: true,
    },
  });

  let total = 0;

  const clientWallets = await prisma.wallet.findMany({
    where: { clientId },
    select: { address: true },
  });
  const walletAddresses = new Set(clientWallets.map(w => w.address.toLowerCase()));

  for (const tx of transactions) {
    const result = tx.simulationResult as { assetChanges?: Array<{ amountUsd?: number; from?: string }> } | null;
    if (result?.assetChanges) {
      for (const change of result.assetChanges) {
        if (change.amountUsd && change.from && walletAddresses.has(change.from.toLowerCase())) {
          total += change.amountUsd;
        }
      }
    }
  }

  return total;
}

export async function getClientPolicy(clientId: string): Promise<ClientPolicy | null> {
  const policy = await prisma.policy.findUnique({
    where: { clientId },
  });

  if (!policy) return null;

  return {
    id: policy.id,
    clientId: policy.clientId,
    maxTransactionUsd: policy.maxTransactionUsd?.toString() || null,
    dailyLimitUsd: policy.dailyLimitUsd?.toString() || null,
    blockUnlimitedApprovals: policy.blockUnlimitedApprovals,
    maxApprovalUsd: policy.maxApprovalUsd?.toString() || null,
    warnUnknownContracts: policy.warnUnknownContracts,
    blockUnknownContracts: policy.blockUnknownContracts,
  };
}
