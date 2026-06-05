import { prisma } from '../../db/index.js';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import { isTransactionProcessed, markTransactionProcessed } from '../../db/redis.js';
import { getSafeApiClient } from '../wallet-monitor/safe-api.js';
import { monitoringControl } from '../monitoring-control.js';
import type { SafeWebhookEvent } from '../../server.js';
import type { SafeMultisigTransaction, TransactionStatus } from '../../models/transaction.js';

const logger = createLogger('webhook-handler');

const PENDING_TX = 'PENDING_MULTISIG_TRANSACTION';
const EXECUTED_TX = 'EXECUTED_MULTISIG_TRANSACTION';
const NEW_CONFIRMATION = 'NEW_CONFIRMATION';

export interface WebhookHandlerCallbacks {
  onNewTransaction: (tx: SafeMultisigTransaction, walletId: string, chainId: number) => Promise<void>;
  onStatusChange: (safeTxHash: string, chainId: number, oldStatus: TransactionStatus, newStatus: TransactionStatus) => Promise<void>;
}

let callbacks: WebhookHandlerCallbacks | null = null;

export function registerHandlerCallbacks(cb: WebhookHandlerCallbacks): void {
  callbacks = cb;
}

export async function handleWebhookEvent(event: SafeWebhookEvent): Promise<void> {
  if (!callbacks) {
    logger.warn('Handler callbacks not registered');
    return;
  }

  const { type, address, safeTxHash, chainId: chainIdStr } = event;
  const chainId = parseInt(chainIdStr, 10);

  if (isNaN(chainId)) {
    logger.warn({ chainId: chainIdStr }, 'Invalid chainId in webhook event');
    return;
  }

  const wallet = await prisma.wallet.findUnique({
    where: { address_chainId: { address, chainId } },
    select: { id: true, isActive: true, type: true },
  });

  if (!wallet) {
    logger.debug({ address, chainId, type }, 'Webhook for unknown wallet — ignoring');
    return;
  }

  if (!wallet.isActive || wallet.type !== 'safe') {
    logger.debug({ address, chainId, type }, 'Webhook for inactive/non-safe wallet — ignoring');
    return;
  }

  switch (type) {
    case PENDING_TX:
      await handlePendingTransaction(safeTxHash, wallet.id, address, chainId);
      break;

    case EXECUTED_TX:
      await handleExecutedTransaction(safeTxHash, wallet.id, chainId);
      break;

    case NEW_CONFIRMATION:
      await handleNewConfirmation(safeTxHash, wallet.id, chainId);
      break;

    default:
      logger.debug({ type, address }, 'Unhandled webhook event type');
  }
}

async function handlePendingTransaction(
  safeTxHash: string | undefined,
  walletId: string,
  safeAddress: string,
  chainId: number
): Promise<void> {
  if (!safeTxHash) {
    logger.warn({ walletId, chainId }, 'PENDING_MULTISIG_TRANSACTION without safeTxHash');
    return;
  }

  const alreadyProcessed = await isTransactionProcessed(safeTxHash, chainId);
  if (alreadyProcessed) {
    logger.debug({ safeTxHash, chainId }, 'Webhook: tx already processed');
    return;
  }

  const isFirstMarker = await markTransactionProcessed(safeTxHash, chainId);
  if (!isFirstMarker) return;

  const existsInDb = await prisma.transactionHistory.findUnique({
    where: { safeTxHash_chainId: { safeTxHash, chainId } },
    select: { id: true },
  });
  if (existsInDb) return;

  const tx = await fetchTransaction(safeTxHash, safeAddress, chainId);
  if (!tx) return;

  logger.info({ safeTxHash, chainId, address: safeAddress }, 'Webhook: new pending transaction');

  monitoringControl.recordActivity().catch(err =>
    logger.error({ error: err }, 'Failed to record activity')
  );

  await callbacks!.onNewTransaction(tx, walletId, chainId);
}

async function handleExecutedTransaction(
  safeTxHash: string | undefined,
  walletId: string,
  chainId: number
): Promise<void> {
  if (!safeTxHash) return;

  const existing = await prisma.transactionHistory.findUnique({
    where: { safeTxHash_chainId: { safeTxHash, chainId } },
    select: { status: true },
  });

  if (!existing) {
    logger.debug({ safeTxHash, chainId }, 'Webhook: executed tx not in DB — ignoring');
    return;
  }

  const oldStatus = existing.status as TransactionStatus;
  if (oldStatus === 'executed' || oldStatus === 'failed') return;

  logger.info({ safeTxHash, chainId, oldStatus }, 'Webhook: transaction executed');
  await callbacks!.onStatusChange(safeTxHash, chainId, oldStatus, 'executed');
}

async function handleNewConfirmation(
  safeTxHash: string | undefined,
  walletId: string,
  chainId: number
): Promise<void> {
  if (!safeTxHash) return;

  const existing = await prisma.transactionHistory.findUnique({
    where: { safeTxHash_chainId: { safeTxHash, chainId } },
    select: { status: true },
  });

  if (!existing) return;

  const oldStatus = existing.status as TransactionStatus;
  if (oldStatus !== 'pending') return;

  logger.info({ safeTxHash, chainId }, 'Webhook: new confirmation → signed');
  await callbacks!.onStatusChange(safeTxHash, chainId, oldStatus, 'signed');
}

async function fetchTransaction(
  safeTxHash: string,
  safeAddress: string,
  chainId: number
): Promise<SafeMultisigTransaction | null> {
  const network = await prisma.network.findUnique({
    where: { chainId },
    select: { safeTxServiceUrl: true },
  });

  if (!network) {
    logger.error({ chainId }, 'Network not found for webhook event');
    return null;
  }

  const client = getSafeApiClient(chainId, network.safeTxServiceUrl, config.safe.apiKey);

  try {
    const tx = await client.getTransaction(safeTxHash);
    if (!tx) {
      logger.warn({ safeTxHash, chainId }, 'Transaction not found in Safe API');
    }
    return tx;
  } catch (error) {
    logger.error({ error, safeTxHash, chainId }, 'Failed to fetch transaction from Safe API');
    return null;
  }
}
