import { prisma } from '../../../db/index.js';
import { createLogger } from '../../../utils/logger.js';
import type { PolicyViolation, PolicyCheckInput } from '../../../models/policy.js';

const logger = createLogger('anomaly-check');

export async function checkAmountAnomaly(
  input: PolicyCheckInput
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  const { transaction, simulationResult, clientId } = input;

  if (!clientId || !simulationResult?.assetChanges) {
    return violations;
  }

  const safeAddress = transaction.from.toLowerCase();
  const currentOutgoingUsd = simulationResult.assetChanges
    .filter(c => c.from && c.from.toLowerCase() === safeAddress)
    .reduce((sum, c) => sum + (c.amountUsd || 0), 0);

  if (currentOutgoingUsd === 0) {
    return violations;
  }

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const historicalTxs = await prisma.transactionHistory.findMany({
    where: {
      wallet: { clientId },
      createdAt: { gte: thirtyDaysAgo },
      status: 'executed',
    },
    select: {
      simulationResult: true,
    },
    take: 100,
  });

  if (historicalTxs.length < 3) {
    return violations;
  }

  const historicalAmounts: number[] = [];

  for (const tx of historicalTxs) {
    const simResult = tx.simulationResult as { assetChanges?: Array<{ from?: string; amountUsd?: number }> } | null;
    if (simResult?.assetChanges) {
      const outgoing = simResult.assetChanges
        .filter(c => c.from && c.from.toLowerCase() === safeAddress)
        .reduce((sum, c) => sum + (c.amountUsd || 0), 0);
      if (outgoing > 0) {
        historicalAmounts.push(outgoing);
      }
    }
  }

  if (historicalAmounts.length < 3) {
    return violations;
  }

  const mean = historicalAmounts.reduce((a, b) => a + b, 0) / historicalAmounts.length;
  const sortedAmounts = [...historicalAmounts].sort((a, b) => a - b);
  const median = sortedAmounts[Math.floor(sortedAmounts.length / 2)];
  const max = sortedAmounts[sortedAmounts.length - 1];

  const anomalyThreshold = Math.max(median * 3, max * 2, 10000);

  if (currentOutgoingUsd > anomalyThreshold) {
    const multiplier = (currentOutgoingUsd / median).toFixed(1);
    violations.push({
      ruleId: 'AMOUNT_ANOMALY',
      severity: 'warning',
      title: '📊 Аномально большая сумма',
      description: `$${currentOutgoingUsd.toLocaleString()} — в ${multiplier}x больше обычного ($${median.toLocaleString()})`,
      details: {
        currentAmount: currentOutgoingUsd,
        median,
        mean,
        max,
        multiplier: parseFloat(multiplier),
      },
    });
  }

  return violations;
}

export async function checkSimilarAddresses(
  input: PolicyCheckInput
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  const { transaction, detectedRecipient, effectiveWhitelists, clientId } = input;

  const addressesToCheck = [transaction.to];
  if (detectedRecipient && detectedRecipient !== transaction.to) {
    addressesToCheck.push(detectedRecipient);
  }

  const knownAddresses: Array<{ address: string; label: string }> = [];

  for (const entry of effectiveWhitelists.addresses) {
    knownAddresses.push({ address: entry.address, label: entry.label || 'Whitelist' });
  }

  if (clientId) {
    const wallets = await prisma.wallet.findMany({
      where: { clientId, isActive: true },
      select: { address: true, name: true },
    });
    for (const w of wallets) {
      knownAddresses.push({ address: w.address, label: w.name || 'Мой кошелёк' });
    }
  }

  for (const checkAddr of addressesToCheck) {
    const similar = findSimilarAddress(checkAddr, knownAddresses);
    if (similar) {
      violations.push({
        ruleId: 'SIMILAR_ADDRESS',
        severity: 'danger',
        title: '🎭 Подозрение на фишинг',
        description: `Адрес похож на "${similar.label}" но отличается! Возможна подмена.`,
        details: {
          suspiciousAddress: checkAddr,
          similarTo: similar.address,
          label: similar.label,
          differences: similar.differences,
        },
      });
    }
  }

  return violations;
}

interface SimilarAddressResult {
  address: string;
  label: string;
  differences: number;
}

function findSimilarAddress(
  address: string,
  knownAddresses: Array<{ address: string; label: string }>
): SimilarAddressResult | null {
  const addrLower = address.toLowerCase();

  for (const known of knownAddresses) {
    const knownLower = known.address.toLowerCase();

    if (addrLower === knownLower) {
      continue;
    }

    const differences = countDifferences(addrLower, knownLower);

    if (differences >= 1 && differences <= 3) {
      const firstMatch = addrLower.slice(2, 8) === knownLower.slice(2, 8);
      const lastMatch = addrLower.slice(-4) === knownLower.slice(-4);

      if (firstMatch || lastMatch) {
        return {
          address: known.address,
          label: known.label,
          differences,
        };
      }
    }

    const first6Match = addrLower.slice(0, 8) === knownLower.slice(0, 8);
    const last4Match = addrLower.slice(-4) === knownLower.slice(-4);

    if (first6Match && last4Match && addrLower !== knownLower) {
      return {
        address: known.address,
        label: known.label,
        differences: countDifferences(addrLower, knownLower),
      };
    }
  }

  return null;
}

function countDifferences(a: string, b: string): number {
  if (a.length !== b.length) {
    return Math.max(a.length, b.length);
  }

  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      diff++;
    }
  }
  return diff;
}
