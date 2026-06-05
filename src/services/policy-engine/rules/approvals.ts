import type { PolicyViolation, ClientPolicy, PolicyCheckInput, EffectiveWhitelists } from '../../../models/policy.js';
import { decodeERC20, isERC20Method, MAX_UINT256_BIGINT } from '../../calldata-decoder/index.js';
import { isProtocolWhitelisted } from '../whitelist.js';
import { getPriceFetcher } from '../../price-fetcher/index.js';
import { lookupToken } from '../../cow-orderbook/tokens.js';
import { createLogger } from '../../../utils/logger.js';
import { normalizeTokenSymbol } from '../../../utils/token-symbols.js';

const logger = createLogger('approvals-check');

const STABLECOINS = new Set(['usdc', 'usdt', 'dai', 'frax', 'lusd']);

export async function checkApprovals(
  input: PolicyCheckInput
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  const { transaction, clientPolicy, effectiveWhitelists, simulationResult, decodedParams } = input;

  let spender: string | undefined;
  let amount: bigint | null = null;
  let isUnlimited = false;
  let tokenAddress: string = transaction.to;

  if (transaction.data && isERC20Method(transaction.data)) {
    const decoded = decodeERC20(transaction.data);
    if (decoded?.method === 'approve') {
      spender = decoded.spender;
      amount = decoded.amount;
      isUnlimited = decoded.isUnlimited;
    }
  }

  if (!spender && decodedParams) {
    const params = decodedParams as {
      method?: string;
      spender?: string;
      amount?: string | bigint;
      isUnlimited?: boolean;
      tokenAddress?: string;
    };
    if (params.method === 'approve' && params.spender) {
      spender = params.spender;
      amount = typeof params.amount === 'bigint'
        ? params.amount
        : (typeof params.amount === 'string' && /^\d+$/.test(params.amount)) ? BigInt(params.amount) : null;
      isUnlimited = params.isUnlimited === true;
      if (params.tokenAddress) tokenAddress = params.tokenAddress;
    }
  }

  if (!spender) {
    return violations;
  }

  const tokenMeta = lookupToken(transaction.chainId, tokenAddress);
  const tokenLabel = tokenMeta?.symbol || `${tokenAddress.slice(0, 6)}…${tokenAddress.slice(-4)}`;
  const formatAmount = (amt: bigint): string => {
    const decimals = tokenMeta?.decimals ?? 18;
    const div = BigInt(10 ** decimals);
    const whole = amt / div;
    const frac = amt % div;
    const fracStr = frac.toString().padStart(decimals, '0').slice(0, 6);
    return `${whole}.${fracStr}`.replace(/\.?0+$/, '') || '0';
  };

  const protocolCheck = isProtocolWhitelisted(
    spender,
    transaction.chainId,
    effectiveWhitelists
  );

  if (isUnlimited) {
    if (!protocolCheck.whitelisted) {
      violations.push({
        ruleId: 'UNLIMITED_APPROVAL_UNKNOWN',
        severity: 'danger',
        title: `Безлимитный approve ${tokenLabel} неизвестному протоколу`,
        description: `Контракт ${spender} получит неограниченный доступ к ${tokenLabel}. При компрометации контракта средства могут быть украдены.`,
        details: {
          spender,
          tokenAddress,
          tokenSymbol: tokenMeta?.symbol || null,
          protocolName: null,
        },
      });
    } else {
      violations.push({
        ruleId: 'UNLIMITED_APPROVAL',
        severity: 'warning',
        title: `Безлимитный approve ${tokenLabel}`,
        description: `${protocolCheck.protocolName} получит неограниченный доступ к ${tokenLabel}. Стандартная практика, но при компрометации контракта средства могут быть украдены.`,
        details: {
          spender,
          tokenAddress,
          tokenSymbol: tokenMeta?.symbol || null,
          protocolName: protocolCheck.protocolName,
        },
      });
    }

    if (clientPolicy?.blockUnlimitedApprovals) {
      violations.push({
        ruleId: 'UNLIMITED_APPROVAL',
        severity: 'danger',
        title: 'Unlimited approvals заблокированы политикой',
        description: `Политика безопасности запрещает безлимитные approve. Текущая попытка: ${tokenLabel} → ${protocolCheck.protocolName || spender}`,
        details: { spender, tokenAddress, tokenSymbol: tokenMeta?.symbol || null },
      });
    }
  }

  if (!isUnlimited && amount !== null && clientPolicy?.maxApprovalUsd) {
    const maxApprovalUsd = parseFloat(clientPolicy.maxApprovalUsd);
    if (maxApprovalUsd > 0) {
      const approvalUsd = await estimateApprovalUsd(tokenAddress, amount, simulationResult);
      if (approvalUsd !== null && approvalUsd > maxApprovalUsd) {
        violations.push({
          ruleId: 'HIGH_APPROVAL',
          severity: 'warning',
          title: `Approve ${tokenLabel} превышает лимит`,
          description: `${formatAmount(amount)} ${tokenLabel} ≈ $${approvalUsd.toLocaleString()} → ${protocolCheck.protocolName || spender}. Лимит: $${maxApprovalUsd.toLocaleString()}.`,
          details: {
            spender,
            tokenAddress,
            tokenSymbol: tokenMeta?.symbol || null,
            approvalUsd,
            maxApprovalUsd,
          },
        });
      }
    }
  }

  return violations;
}

async function estimateApprovalUsd(
  tokenAddress: string,
  amount: bigint,
  simulationResult?: PolicyCheckInput['simulationResult']
): Promise<number | null> {
  try {
    if (simulationResult?.assetChanges) {
      for (const change of simulationResult.assetChanges) {
        if (change.tokenAddress?.toLowerCase() === tokenAddress.toLowerCase() && change.tokenSymbol) {
          const symbol = normalizeTokenSymbol(change.tokenSymbol);
          const priceFetcher = getPriceFetcher();
          const price = await priceFetcher.getPrice(symbol);
          if (price !== null) {
            const decimals = STABLECOINS.has(symbol.toLowerCase()) ? 6 : 18;
            const amountFloat = Number(amount) / (10 ** decimals);
            return amountFloat * price;
          }
        }
      }
    }

    return null;
  } catch (error) {
    logger.debug({ error, tokenAddress }, 'Failed to estimate approval USD value');
    return null;
  }
}
