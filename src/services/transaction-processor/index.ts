import { prisma } from '../../db/index.js';
import { createLogger } from '../../utils/logger.js';
import { getTenderlyClient } from './tenderly.js';
import { extractRecipient, decodeCalldata, decodeERC20, isERC20Method, decodeSelector, getDisplayMethodName, getProtocolDisplayMethod, summarizeMultiSendCalls } from '../calldata-decoder/index.js';
import { isCowMethod } from '../calldata-decoder/cow.js';

function containsCowMethod(data: string): boolean {
  if (isCowMethod(data)) return true;

  if (data.slice(0, 10).toLowerCase() === '0x8d80ff0a') {
    const lower = data.toLowerCase();
    return lower.includes('ec6cb13f')
        || lower.includes('2689f0a7');
  }
  return false;
}
import { getPriceFetcher } from '../price-fetcher/index.js';
import { resolveCowOrders } from '../cow-orderbook/index.js';
import type { CowOrderInfo } from '../cow-orderbook/index.js';
import type { SafeMultisigTransaction, ProcessedTransaction, SimulationResult, RiskLevel, EtherscanTransaction } from '../../models/transaction.js';
import type { PolicyViolation } from '../../models/policy.js';

const logger = createLogger('tx-processor');

export interface ProcessTransactionResult {
  transaction: ProcessedTransaction;
  simulationResult: SimulationResult | null;
}

export async function processTransaction(
  safeTx: SafeMultisigTransaction,
  walletId: string,
  chainId: number,
  skipSimulation = false
): Promise<ProcessTransactionResult> {
  const safeAddress = safeTx.safe;

  logger.info(
    { safeTxHash: safeTx.safeTxHash, chainId, to: safeTx.to },
    'Processing Safe transaction'
  );

  const network = await prisma.network.findUnique({
    where: { chainId },
  });

  if (!network) {
    throw new Error(`Network ${chainId} not found`);
  }

  const isSelfCall = safeTx.to.toLowerCase() === safeAddress.toLowerCase();
  const hasCowInnerCall = safeTx.data ? containsCowMethod(safeTx.data) : false;

  const innerCalls = safeTx.data ? summarizeMultiSendCalls(safeTx.data) : [];
  const isSafeAdminBatch = innerCalls.length > 0 && innerCalls.every(c =>
    c.protocol === 'Safe' && c.to.toLowerCase() === safeAddress.toLowerCase()
  );
  let simulationResult: SimulationResult | null = null;
  if (!skipSimulation && !isSelfCall && !hasCowInnerCall && !isSafeAdminBatch) {
    const tenderly = getTenderlyClient();
    simulationResult = await tenderly.simulate({
      networkId: network.tenderlyNetworkId,
      from: safeAddress,
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data || '0x',
    });
  }
  let cowOrders: CowOrderInfo[] | undefined;
  let unresolvedTokenAddresses: string[] | undefined;
  if (hasCowInnerCall && safeTx.data) {
    const { assetChanges, orders, unresolved } = await resolveCowOrders(chainId, safeTx.data, safeAddress);
    if (orders.length > 0) {
      simulationResult = {
        success: true,
        assetChanges,
        logs: [],
      };
      cowOrders = orders;
      logger.info(
        {
          safeTxHash: safeTx.safeTxHash,
          ordersResolved: orders.length,
          classes: orders.map(o => o.class),
          cancels: orders.filter(o => o.cancelled).length,
        },
        'CoW order(s) resolved via orderbook'
      );
    } else {
      logger.info(
        { safeTxHash: safeTx.safeTxHash },
        'CoW order(s) not found in orderbook (likely too soon after creation or unsupported chain)'
      );
    }
    if (unresolved.length > 0) {
      unresolvedTokenAddresses = unresolved;
    }
  }

  const decoded = decodeCalldata(safeTx.data, safeTx.to);

  let methodName = decoded.method;
  let methodDisplay: string | undefined;
  if (!decoded.protocol && safeTx.data && safeTx.data !== '0x') {
    const selectorInfo = await decodeSelector(safeTx.data);
    if (selectorInfo.signature) {
      methodName = selectorInfo.methodName;
      methodDisplay = selectorInfo.displayName;
      logger.debug({ selector: selectorInfo.selector, signature: selectorInfo.signature }, 'Decoded via signature lookup');
    }
  } else if (decoded.protocol && decoded.method) {
    methodDisplay = getProtocolDisplayMethod(decoded.protocol, decoded.method)
      || getDisplayMethodName(decoded.method);
  }

  const recipientResult = extractRecipient(safeTx.to, safeTx.data, safeAddress);

  if (!methodName && recipientResult.method && recipientResult.method !== 'unknown' && recipientResult.method !== 'native_transfer') {
    methodName = recipientResult.method;
    methodDisplay = recipientResult.method;
  }

  if (!methodName && (!recipientResult.method || recipientResult.method === 'unknown')) {
    const selector = safeTx.data && safeTx.data.length >= 10 ? safeTx.data.slice(0, 10) : 'no-data';
    logger.warn(
      { safeTxHash: safeTx.safeTxHash, to: safeTx.to, selector },
      'Both calldata and recipient decoders failed to identify method'
    );
  }

  if (!methodDisplay && !methodName && safeTx.data && safeTx.data !== '0x') {
    logger.warn({ safeTxHash: safeTx.safeTxHash, selector: safeTx.data.slice(0, 10), to: safeTx.to }, 'Both calldata and recipient decoders failed to identify method');
  }

  const status = safeTx.isExecuted
    ? (safeTx.isSuccessful ? 'executed' : 'failed')
    : (safeTx.confirmations.length >= safeTx.confirmationsRequired ? 'signed' : 'pending');

  const processed: ProcessedTransaction = {
    safeTxHash: safeTx.safeTxHash,
    txHash: safeTx.transactionHash || undefined,
    walletType: 'safe',
    chainId,
    walletAddress: safeAddress,
    nonce: safeTx.nonce,
    to: safeTx.to,
    value: safeTx.value,
    data: safeTx.data,
    operation: safeTx.operation,
    status,
    confirmations: safeTx.confirmations.length,
    confirmationsRequired: safeTx.confirmationsRequired,
    decodedMethod: methodDisplay || methodName || undefined,
    decodedParams: decoded.params || undefined,
    detectedRecipient: recipientResult.recipient || undefined,
    detectedProtocol: decoded.protocol || recipientResult.protocol || undefined,
    destinationChainId: decoded.destinationChainId ?? undefined,
    simulationSuccess: simulationResult?.success,
    simulationResult: simulationResult || undefined,
    cowOrders,
    unresolvedTokenAddresses,
    multiSendInnerCalls: innerCalls.length > 0 ? innerCalls : undefined,
    riskLevel: 'ok',
    violations: [],
  };

  return {
    transaction: processed,
    simulationResult,
  };
}

export async function processEoaTransaction(
  ethTx: EtherscanTransaction,
  walletId: string,
  walletAddress: string,
  chainId: number
): Promise<ProcessTransactionResult> {
  logger.info(
    { txHash: ethTx.hash, chainId, to: ethTx.to, from: ethTx.from },
    'Processing EOA transaction'
  );

  const calldata = ethTx.input && ethTx.input !== '0x' ? ethTx.input : null;
  const decoded = decodeCalldata(calldata, ethTx.to);

  let methodName = decoded.method;
  let methodDisplay: string | undefined;
  if (!decoded.protocol && calldata && calldata !== '0x') {
    const selectorInfo = await decodeSelector(calldata);
    if (selectorInfo.signature) {
      methodName = selectorInfo.methodName;
      methodDisplay = selectorInfo.displayName;
    }
  } else if (decoded.protocol && decoded.method) {
    methodDisplay = getProtocolDisplayMethod(decoded.protocol, decoded.method)
      || getDisplayMethodName(decoded.method);
  }

  const recipientResult = extractRecipient(ethTx.to, calldata, walletAddress);

  const isError = ethTx.isError === '1' || ethTx.txreceipt_status === '0';
  const status = isError ? 'failed' : 'executed';

  const processed: ProcessedTransaction = {
    txHash: ethTx.hash,
    walletType: 'eoa',
    chainId,
    walletAddress,
    from: ethTx.from,
    nonce: parseInt(ethTx.nonce) || undefined,
    to: ethTx.to,
    value: ethTx.value,
    data: calldata,
    status,
    gasUsed: parseInt(ethTx.gasUsed) || undefined,
    gasPrice: ethTx.gasPrice || undefined,
    blockNumber: parseInt(ethTx.blockNumber) || undefined,
    decodedMethod: methodDisplay || methodName || undefined,
    decodedParams: decoded.params || undefined,
    detectedRecipient: recipientResult.recipient || undefined,
    detectedProtocol: decoded.protocol || recipientResult.protocol || undefined,
    riskLevel: 'ok',
    violations: [],
  };

  return {
    transaction: processed,
    simulationResult: null,
  };
}

function sanitizeForJson(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(sanitizeForJson);
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      result[key] = sanitizeForJson(value);
    }
    return result;
  }
  return obj;
}

export async function saveTransaction(
  processed: ProcessedTransaction,
  walletId: string,
  violations: PolicyViolation[],
  riskLevel: RiskLevel
): Promise<void> {
  if (processed.walletType === 'safe' && processed.safeTxHash) {
    await prisma.transactionHistory.upsert({
      where: {
        safeTxHash_chainId: {
          safeTxHash: processed.safeTxHash,
          chainId: processed.chainId,
        },
      },
      update: {
        txHash: processed.txHash,
        status: processed.status,
        simulationSuccess: processed.simulationSuccess,
        simulationResult: sanitizeForJson(processed.simulationResult) as object,
        decodedMethod: processed.decodedMethod,
        decodedParams: sanitizeForJson(processed.decodedParams) as object,
        detectedRecipient: processed.detectedRecipient,
        riskLevel,
        policyViolations: sanitizeForJson(violations) as object[],
        updatedAt: new Date(),
      },
      create: {
        walletId,
        safeTxHash: processed.safeTxHash,
        txHash: processed.txHash,
        chainId: processed.chainId,
        nonce: processed.nonce,
        fromAddress: processed.walletAddress,
        toAddress: processed.to,
        valueWei: processed.value,
        data: processed.data,
        operation: processed.operation,
        status: processed.status,
        simulationSuccess: processed.simulationSuccess,
        simulationResult: sanitizeForJson(processed.simulationResult) as object,
        decodedMethod: processed.decodedMethod,
        decodedParams: sanitizeForJson(processed.decodedParams) as object,
        detectedRecipient: processed.detectedRecipient,
        riskLevel,
        policyViolations: sanitizeForJson(violations) as object[],
      },
    });
  } else if (processed.txHash) {
    await prisma.transactionHistory.upsert({
      where: {
        txHash_chainId: {
          txHash: processed.txHash,
          chainId: processed.chainId,
        },
      },
      update: {
        decodedMethod: processed.decodedMethod,
        decodedParams: sanitizeForJson(processed.decodedParams) as object,
        detectedRecipient: processed.detectedRecipient,
        riskLevel,
        policyViolations: sanitizeForJson(violations) as object[],
        updatedAt: new Date(),
      },
      create: {
        walletId,
        txHash: processed.txHash,
        chainId: processed.chainId,
        nonce: processed.nonce,
        fromAddress: processed.from || processed.walletAddress,
        toAddress: processed.to,
        valueWei: processed.value,
        data: processed.data,
        status: processed.status,
        gasUsed: processed.gasUsed ? BigInt(processed.gasUsed) : null,
        gasPrice: processed.gasPrice ? BigInt(processed.gasPrice) : null,
        blockNumber: processed.blockNumber,
        decodedMethod: processed.decodedMethod,
        decodedParams: sanitizeForJson(processed.decodedParams) as object,
        detectedRecipient: processed.detectedRecipient,
        executedAt: new Date(),
        riskLevel,
        policyViolations: sanitizeForJson(violations) as object[],
      },
    });
  }

  const id = processed.safeTxHash || processed.txHash || 'unknown';
  logger.info({ id, chainId: processed.chainId, riskLevel }, 'Transaction saved');
}

export async function updateTransactionStatus(
  safeTxHash: string,
  chainId: number,
  status: string,
  executedAt?: Date
): Promise<void> {
  await prisma.transactionHistory.update({
    where: {
      safeTxHash_chainId: { safeTxHash, chainId },
    },
    data: {
      status,
      executedAt,
      updatedAt: new Date(),
    },
  });

  logger.info({ safeTxHash, chainId, status }, 'Transaction status updated');
}

export function getApprovalInfo(data: string | null): {
  isApproval: boolean;
  spender: string | null;
  amount: bigint | null;
  isUnlimited: boolean;
} {
  if (!data || !isERC20Method(data)) {
    return { isApproval: false, spender: null, amount: null, isUnlimited: false };
  }

  const decoded = decodeERC20(data);
  if (!decoded || decoded.method !== 'approve') {
    return { isApproval: false, spender: null, amount: null, isUnlimited: false };
  }

  return {
    isApproval: true,
    spender: decoded.spender,
    amount: decoded.amount,
    isUnlimited: decoded.isUnlimited,
  };
}
