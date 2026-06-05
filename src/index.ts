import { config } from './config/index.js';

import * as Sentry from "@sentry/node";
if (config.sentry.dsn) {
  Sentry.init({ dsn: config.sentry.dsn });
}
import { connectDatabase, disconnectDatabase, prisma } from './db/index.js';
import { redis, disconnectRedis } from './db/redis.js';
import { runSeeds } from './db/seed.js';
import { createLogger } from './utils/logger.js';
import { startBot, stopBot, getBot, sendTransactionNotification, sendStatusNotification } from './services/telegram-bot/index.js';
import { WalletMonitor } from './services/wallet-monitor/index.js';
import { EoaMonitor } from './services/wallet-monitor/eoa-monitor.js';
import { processTransaction, processEoaTransaction, saveTransaction, updateTransactionStatus } from './services/transaction-processor/index.js';
import { checkPolicies } from './services/policy-engine/index.js';
import { analyzeTransaction, type AIAnalysisContext } from './services/ai-analyzer/index.js';
import { sendWeeklyDigests } from './services/digest/index.js';
import { monitoringControl } from './services/monitoring-control.js';
import { startServer, stopServer, registerWebhookCallbacks } from './server.js';
import { registerHandlerCallbacks, handleWebhookEvent } from './services/webhook/handler.js';
import type { SafeMultisigTransaction, EtherscanTransaction, TransactionStatus } from './models/transaction.js';

const logger = createLogger('main');

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'Unhandled promise rejection');
  Sentry.captureException(reason);
});

process.on('uncaughtException', (error) => {
  logger.fatal({ error }, 'Uncaught exception — shutting down');
  Sentry.captureException(error);

  setTimeout(() => process.exit(1), 2000);
});

let walletMonitor: WalletMonitor | null = null;
let eoaMonitor: EoaMonitor | null = null;
let digestCheckInterval: NodeJS.Timeout | null = null;
let monitoringActive = false;

async function main() {
  logger.info({ env: config.app.env }, 'Starting Transaction Guardian Bot v3.6.0');

  await connectDatabase();

  await redis.ping();
  logger.info('Redis connection verified');

  await runSeeds();

  const [clients, safeWallets, eoaWallets, networks] = await Promise.all([
    prisma.client.count(),
    prisma.wallet.count({ where: { type: 'safe' } }),
    prisma.wallet.count({ where: { type: 'eoa' } }),
    prisma.network.count({ where: { isEnabled: true } }),
  ]);

  logger.info({
    clients,
    safeWallets,
    eoaWallets,
    networks,
    tenderlyConfigured: config.tenderly.isConfigured,
    etherscanConfigured: config.etherscan.isConfigured,
  }, 'System status');

  await startBot();
  logger.info('Telegram bot started');

  const webhookMode = config.webhook.enabled;
  const standbyMs = webhookMode ? Math.max(config.polling.safeStandbyIntervalMs, 1_800_000) : config.polling.safeStandbyIntervalMs;
  const activeMs = webhookMode ? Math.max(config.polling.safeActiveIntervalMs, 60_000) : config.polling.safeActiveIntervalMs;

  walletMonitor = new WalletMonitor({
    standbyIntervalMs: standbyMs,
    activeIntervalMs: activeMs,
    onNewTransaction: handleNewSafeTransaction,
    onStatusChange: handleStatusChange,
    onPendingTxDetected: () => {
      monitoringControl.recordActivity().catch(err =>
        logger.error({ error: err }, 'Failed to record activity')
      );
    },
    onQuotaExhausted: (resetAt: Date) => {
      sendAdminAlert(
        `\u26a0\ufe0f Safe API: monthly quota exhausted\n`
        + `Auto-recovery scheduled: ${resetAt.toUTCString()}\n`
        + `Rechecking every 6 hours. No action needed.`
      );
    },
    onQuotaRestored: () => {
      sendAdminAlert(`\u2705 Safe API: quota restored — monitoring resumed`);
    },
  });

  if (config.etherscan.isConfigured) {
    eoaMonitor = new EoaMonitor({
      pollIntervalMs: config.polling.eoaIntervalMs,
      onNewTransaction: handleNewEoaTransaction,
    });
  }

  if (config.webhook.enabled) {
    registerHandlerCallbacks({
      onNewTransaction: handleNewSafeTransaction,
      onStatusChange: handleStatusChange,
    });
    registerWebhookCallbacks({ onWebhookEvent: handleWebhookEvent });
    await startServer();

    if (config.webhook.isConfigured) {
      logger.info('Webhook mode enabled (HMAC verification active), polling is fallback');
    } else {
      logger.warn('⚠️ Webhook server started WITHOUT HMAC verification (SAFE_WEBHOOK_SECRET not set). Set it to prevent unauthorized webhook calls.');
    }
  }

  monitoringControl.register(
    async () => {
      if (walletMonitor) await walletMonitor.start();
      if (eoaMonitor) await eoaMonitor.start();
      monitoringActive = true;
      logger.info({ mode: monitoringControl.getMode() }, 'Monitors started');
    },
    () => {
      if (walletMonitor) walletMonitor.stop();
      if (eoaMonitor) eoaMonitor.stop();
      monitoringActive = false;
      logger.info('Monitors stopped');
    },

    (_newMode, intervalMs) => {
      if (walletMonitor) walletMonitor.setPollInterval(intervalMs);
    }
  );

  digestCheckInterval = setInterval(() => {
    sendWeeklyDigests().catch(err => logger.error({ error: err }, 'Digest check failed'));
  }, 60 * 60 * 1000);

  await monitoringControl.restoreState();

  const currentMode = monitoringControl.getMode();
  logger.info(
    { mode: currentMode },
    currentMode === 'off'
      ? 'Transaction Guardian Bot v3.6.0 is running (monitoring OFF — enable via TG bot)'
      : `Transaction Guardian Bot v3.6.0 is running (monitoring restored: ${currentMode})`
  );

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function handleNewSafeTransaction(
  safeTx: SafeMultisigTransaction,
  walletId: string,
  chainId: number
): Promise<void> {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      include: { client: true },
    });

    if (!wallet) {
      logger.error({ walletId }, 'Wallet not found');
      return;
    }

    const { transaction, simulationResult } = await processTransaction(safeTx, walletId, chainId, false);

    const { riskLevel, violations } = await checkPolicies(
      transaction,
      wallet.clientId,
      simulationResult || undefined
    );

    await saveTransaction(transaction, walletId, violations, riskLevel);

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

    let aiAnalysis: Awaited<ReturnType<typeof analyzeTransaction>> = null;
    const isSelfCall = transaction.to.toLowerCase() === transaction.walletAddress.toLowerCase();
    if (config.ai.isConfigured && !isSelfCall) {
      const network = await prisma.network.findUnique({
        where: { chainId },
        select: { name: true },
      });
      aiAnalysis = await analyzeTransaction(transaction, violations, network?.name, transaction.detectedProtocol, aiContext);
    }

    await sendTransactionNotification(wallet.clientId, transaction, violations, riskLevel, aiAnalysis);

    logger.info(
      {
        safeTxHash: safeTx.safeTxHash,
        chainId,
        clientId: wallet.clientId,
        riskLevel,
        violationsCount: violations.length,
      },
      'Safe transaction processed'
    );
  } catch (error) {
    logger.error({
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      safeTxHash: safeTx.safeTxHash,
      chainId
    }, 'Error handling Safe transaction');
  }
}

async function handleNewEoaTransaction(
  ethTx: EtherscanTransaction,
  walletId: string,
  walletAddress: string,
  chainId: number
): Promise<void> {
  try {
    const wallet = await prisma.wallet.findUnique({
      where: { id: walletId },
      include: { client: true },
    });

    if (!wallet) {
      logger.error({ walletId }, 'Wallet not found');
      return;
    }

    const { transaction } = await processEoaTransaction(ethTx, walletId, walletAddress, chainId);

    const { riskLevel, violations } = await checkPolicies(transaction, wallet.clientId);

    await saveTransaction(transaction, walletId, violations, riskLevel);

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

    let aiAnalysis: Awaited<ReturnType<typeof analyzeTransaction>> = null;
    if (config.ai.isConfigured) {
      const network = await prisma.network.findUnique({
        where: { chainId },
        select: { name: true },
      });
      aiAnalysis = await analyzeTransaction(transaction, violations, network?.name, transaction.detectedProtocol, aiContext);
    }

    await sendTransactionNotification(wallet.clientId, transaction, violations, riskLevel, aiAnalysis);

    logger.info(
      {
        txHash: ethTx.hash,
        chainId,
        clientId: wallet.clientId,
        riskLevel,
      },
      'EOA transaction processed'
    );
  } catch (error) {
    logger.error({
      error: error instanceof Error ? { message: error.message, stack: error.stack } : error,
      txHash: ethTx.hash,
      chainId
    }, 'Error handling EOA transaction');
  }
}

async function handleStatusChange(
  safeTxHash: string,
  chainId: number,
  oldStatus: TransactionStatus,
  newStatus: TransactionStatus
): Promise<void> {
  try {
    const executedAt = newStatus === 'executed' ? new Date() : undefined;
    await updateTransactionStatus(safeTxHash, chainId, newStatus, executedAt);

    await sendStatusNotification(safeTxHash, chainId, newStatus);

    logger.info({ safeTxHash, chainId, oldStatus, newStatus }, 'Transaction status updated');
  } catch (error) {
    logger.error({ error, safeTxHash, chainId }, 'Error handling status change');
  }
}

function sendAdminAlert(text: string): void {
  const adminId = config.telegram.adminUserId;
  const bot = getBot();
  if (!adminId || !bot) return;
  bot.api.sendMessage(adminId, text).catch(err =>
    logger.error({ error: err }, 'Failed to send admin alert')
  );
}

async function shutdown() {
  logger.info('Shutting down...');

  if (walletMonitor) walletMonitor.stop();
  if (eoaMonitor) eoaMonitor.stop();
  if (digestCheckInterval) clearInterval(digestCheckInterval);

  await stopServer();
  await stopBot();
  await disconnectDatabase();
  await disconnectRedis();

  logger.info('Shutdown complete');
  process.exit(0);
}

main().catch((error) => {
  logger.fatal({ error }, 'Fatal error');
  process.exit(1);
});
