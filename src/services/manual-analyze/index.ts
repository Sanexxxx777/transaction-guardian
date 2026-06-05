import { prisma } from '../../db/index.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { getSafeApiClient, RateLimitError, type RateLimitInfo } from '../wallet-monitor/safe-api.js';
import { processTransaction, saveTransaction } from '../transaction-processor/index.js';
import { checkPolicies } from '../policy-engine/index.js';
import { analyzeTransaction, type AIAnalysisContext, type AIAnalysisResult } from '../ai-analyzer/index.js';
import { sendTransactionNotification } from '../telegram-bot/notifications.js';
import { audit } from '../audit-log/index.js';
import { parseSafeTxUrl } from './url-parser.js';
import type { RiskLevel } from '../../models/transaction.js';

const logger = createLogger('manual-analyze');

export type AnalyzeStage =
  | 'parsing'
  | 'wallet_lookup'
  | 'safe_api'
  | 'simulation'
  | 'policy'
  | 'ai'
  | 'sending'
  | 'done';

export interface AnalyzeOptions {
  adminId: string | number | bigint;
  adminName?: string;

  allowDuplicate?: boolean;

  onProgress?: (stage: AnalyzeStage) => Promise<void> | void;

  targetChatId?: bigint | number;
}

export type AnalyzeResult =
  | {
      status: 'ok';
      riskLevel: RiskLevel;
      clientChatId: bigint;
      clientName: string;
      walletName: string | null;
      violationCount: number;
      aiHeadline?: string;
      chainId: number;
      unresolvedTokens: string[];
    }
  | { status: 'invalid_url'; error: string }
  | { status: 'wallet_not_found'; address: string; chainId: number }
  | { status: 'tx_not_found'; safeTxHash: string }
  | { status: 'rate_limited'; info: RateLimitInfo }
  | {
      status: 'already_analyzed';
      safeTxHash: string;
      chainId: number;
      existingStatus: string;
      existingRiskLevel: string | null;
    }
  | {
      status: 'notification_failed';
      clientName: string;
      clientChatId: bigint;
      riskLevel: RiskLevel;
      chainId: number;
      unresolvedTokens: string[];
    }
  | { status: 'error'; error: string };

export async function analyzeBySafeUrl(
  url: string,
  opts: AnalyzeOptions
): Promise<AnalyzeResult> {
  const progress = opts.onProgress ?? (() => {});

  await progress('parsing');
  const parsed = parseSafeTxUrl(url);
  if (!parsed.ok) {
    return { status: 'invalid_url', error: parsed.error };
  }
  const { chainId, safeAddress, safeTxHash } = parsed.value;

  await progress('wallet_lookup');
  const wallet = await prisma.wallet.findFirst({
    where: {
      address: { equals: safeAddress, mode: 'insensitive' },
      chainId,
    },
    include: { client: true },
  });

  if (!wallet) {
    return { status: 'wallet_not_found', address: safeAddress, chainId };
  }

  if (wallet.type !== 'safe') {
    return {
      status: 'invalid_url',
      error: `Кошелёк ${safeAddress} зарегистрирован как EOA — для него ручной анализ multisig-транзакций не применим`,
    };
  }

  if (!opts.allowDuplicate) {
    const existing = await prisma.transactionHistory.findUnique({
      where: { safeTxHash_chainId: { safeTxHash, chainId } },
      select: { status: true, riskLevel: true },
    });
    if (existing && existing.status !== 'pending') {
      return {
        status: 'already_analyzed',
        safeTxHash,
        chainId,
        existingStatus: existing.status,
        existingRiskLevel: existing.riskLevel,
      };
    }
  }

  await progress('safe_api');
  const network = await prisma.network.findUnique({
    where: { chainId },
    select: { safeTxServiceUrl: true, name: true },
  });
  if (!network) {
    return { status: 'error', error: `Сеть ${chainId} не настроена в БД` };
  }

  const safeApi = getSafeApiClient(chainId, network.safeTxServiceUrl, config.safe.apiKey || undefined);

  let safeTx;
  try {
    safeTx = await safeApi.getTransaction(safeTxHash);
  } catch (error) {
    if (error instanceof RateLimitError) {
      return { status: 'rate_limited', info: error.rateLimitInfo };
    }
    logger.error(
      { error, safeTxHash, chainId },
      'Failed to fetch transaction from Safe API'
    );
    return {
      status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!safeTx) {
    return { status: 'tx_not_found', safeTxHash };
  }

  if (safeTx.safe.toLowerCase() !== safeAddress.toLowerCase()) {
    return {
      status: 'error',
      error: `Safe API вернул tx с адресом ${safeTx.safe}, но в URL ${safeAddress}`,
    };
  }

  await progress('simulation');
  const { transaction, simulationResult } = await processTransaction(
    safeTx,
    wallet.id,
    chainId,
    false
  );

  await progress('policy');
  const { riskLevel, violations } = await checkPolicies(
    transaction,
    wallet.clientId,
    simulationResult || undefined
  );

  await saveTransaction(transaction, wallet.id, violations, riskLevel);

  let aiContext: AIAnalysisContext | undefined;
  const recipient = transaction.detectedRecipient || transaction.to;
  if (recipient) {
    const isOwnWallet = recipient.toLowerCase() === transaction.walletAddress.toLowerCase();
    if (isOwnWallet) {
      aiContext = { isRecipientWhitelisted: true, recipientLabel: 'Мой кошелёк' };
    } else {
      const whitelistEntry = await prisma.addressWhitelist.findFirst({
        where: {
          address: { equals: recipient, mode: 'insensitive' },
          isActive: true,
          OR: [{ clientId: wallet.clientId }, { clientId: null }],
        },
      });
      aiContext = {
        isRecipientWhitelisted: !!whitelistEntry,
        recipientLabel: whitelistEntry?.label || undefined,
      };
    }
  }

  await progress('ai');
  let aiAnalysis: AIAnalysisResult | null = null;
  const isSelfCall = transaction.to.toLowerCase() === transaction.walletAddress.toLowerCase();
  if (config.ai.isConfigured && !isSelfCall) {
    aiAnalysis = await analyzeTransaction(
      transaction,
      violations,
      network.name,
      transaction.detectedProtocol,
      aiContext
    );
  }

  await progress('sending');
  const sent = await sendTransactionNotification(
    wallet.clientId,
    transaction,
    violations,
    riskLevel,
    aiAnalysis,
    opts.targetChatId,
  );

  await audit({
    action: 'manual_analyze',
    actorId: opts.adminId,
    actorName: opts.adminName,
    targetId: wallet.id,
    targetType: 'wallet',
    details: {
      safeTxHash,
      chainId,
      riskLevel,
      violationCount: violations.length,
      clientId: wallet.clientId,
      sent,
    },
  });

  await progress('done');

  const unresolvedTokens = transaction.unresolvedTokenAddresses || [];

  if (!sent) {
    return {
      status: 'notification_failed',
      clientName: wallet.client.name,
      clientChatId: wallet.client.telegramChatId,
      riskLevel,
      chainId,
      unresolvedTokens,
    };
  }

  return {
    status: 'ok',
    riskLevel,
    clientChatId: wallet.client.telegramChatId,
    clientName: wallet.client.name,
    walletName: wallet.name,
    violationCount: violations.length,
    aiHeadline: aiAnalysis?.headline,
    chainId,
    unresolvedTokens,
  };
}
