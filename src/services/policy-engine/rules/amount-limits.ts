import type { PolicyViolation, ClientPolicy, PolicyCheckInput } from '../../../models/policy.js';
import type { AssetChange } from '../../../models/transaction.js';

export function checkAmountLimits(
  input: PolicyCheckInput
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const policy = input.clientPolicy;

  if (!policy) return violations;

  const totalOutgoingUsd = calculateOutgoingUsd(input);

  if (policy.maxTransactionUsd !== null) {
    const limit = parseFloat(policy.maxTransactionUsd);
    if (totalOutgoingUsd > limit) {
      violations.push({
        ruleId: 'AMOUNT_EXCEEDED',
        severity: 'warning',
        title: 'Превышен лимит транзакции',
        description: `Сумма $${totalOutgoingUsd.toLocaleString()} превышает лимит $${limit.toLocaleString()}`,
        details: {
          amount: totalOutgoingUsd,
          limit,
        },
      });
    }
  }

  if (policy.dailyLimitUsd !== null && input.dailySpentUsd !== undefined) {
    const limit = parseFloat(policy.dailyLimitUsd);
    const totalDaily = input.dailySpentUsd + totalOutgoingUsd;

    if (totalDaily > limit) {
      violations.push({
        ruleId: 'DAILY_LIMIT_EXCEEDED',
        severity: 'warning',
        title: 'Превышен дневной лимит',
        description: `Сумма за день $${totalDaily.toLocaleString()} превысит лимит $${limit.toLocaleString()}`,
        details: {
          dailySpent: input.dailySpentUsd,
          currentAmount: totalOutgoingUsd,
          totalDaily,
          limit,
        },
      });
    }
  }

  return violations;
}

function calculateOutgoingUsd(input: PolicyCheckInput): number {
  if (!input.simulationResult?.assetChanges) {
    return 0;
  }

  const safeAddress = input.transaction.from.toLowerCase();

  return input.simulationResult.assetChanges
    .filter((change) => change.from && change.from.toLowerCase() === safeAddress)
    .reduce((sum, change) => sum + (change.amountUsd || 0), 0);
}
