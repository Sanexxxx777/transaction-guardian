
export interface SafeMultisigTransaction {
  safe: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  safeTxGas: string;
  baseGas: string;
  gasPrice: string;
  gasToken: string;
  refundReceiver: string;
  nonce: number;
  safeTxHash: string;
  submissionDate: string;
  executionDate: string | null;
  confirmations: SafeConfirmation[];
  confirmationsRequired: number;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  transactionHash: string | null;
  executor: string | null;
  trusted: boolean;
}

export interface SafeConfirmation {
  owner: string;
  signature: string;
  signatureType: string;
  submissionDate: string;
}

export type WalletType = 'safe' | 'eoa';

export type TransactionStatus = 'pending' | 'signed' | 'executed' | 'rejected' | 'failed';

export type RiskLevel = 'ok' | 'info' | 'warning' | 'danger';

export interface ProcessedTransaction {
  safeTxHash?: string;
  txHash?: string;

  walletType: WalletType;
  chainId: number;
  walletAddress: string;
  from?: string;
  nonce?: number;
  to: string;
  value: string;
  data: string | null;
  operation?: number;
  status: TransactionStatus;

  confirmations?: number;
  confirmationsRequired?: number;

  gasUsed?: number;
  gasPrice?: string;
  blockNumber?: number;

  decodedMethod?: string;
  decodedParams?: Record<string, unknown>;
  detectedRecipient?: string;
  detectedProtocol?: string;
  destinationChainId?: number;

  simulationSuccess?: boolean;
  simulationResult?: SimulationResult;

  unresolvedTokenAddresses?: string[];

  cowOrders?: Array<{
    uid: string;
    class: 'market' | 'limit' | 'liquidity';
    kind: 'sell' | 'buy';
    sellSymbol: string;
    buySymbol: string;
    sellTokenAddress: string;
    buyTokenAddress: string;
    sellAmountRaw: string;
    buyAmountRaw: string;
    sellAmount: string;
    buyAmount: string;
    sellDecimals: number;
    buyDecimals: number;
    validToTimestamp: number;
    receiver: string;
    receiverIsSelf: boolean;
    partiallyFillable: boolean;
    status?: string;

    cancelled?: boolean;
  }>;

  multiSendInnerCalls?: Array<{
    to: string;
    method: string | null;
    protocol: string | null;
    params?: Record<string, unknown> | null;
  }>;

  riskLevel: RiskLevel;
  violations: PolicyViolation[];
}

export type { ProcessedTransaction as SafeProcessedTransaction };

export interface SimulationResult {
  success: boolean;
  gasUsed?: number;
  error?: string;
  assetChanges: AssetChange[];
  logs: SimulationLog[];
}

export interface AssetChange {
  type: 'erc20' | 'native' | 'erc721' | 'erc1155';
  tokenAddress?: string;
  tokenSymbol?: string;
  tokenDecimals?: number;
  from: string;
  to: string;
  amount: string;
  amountUsd?: number;
}

export interface SimulationLog {
  address: string;
  topics: string[];
  data: string;
  decoded?: {
    name: string;
    params: Record<string, unknown>;
  };
}

export interface PolicyViolation {
  ruleId: string;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  description: string;
  details?: Record<string, unknown>;
}

export interface RecipientExtractionResult {
  recipient: string | null;
  protocol: string | null;
  method: string | null;
  confidence: 'high' | 'medium' | 'low';
  isImplicitSender: boolean;
}

export interface EtherscanTransaction {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  nonce: string;
  blockHash: string;
  transactionIndex: string;
  from: string;
  to: string;
  value: string;
  gas: string;
  gasPrice: string;
  isError: string;
  txreceipt_status: string;
  input: string;
  contractAddress: string;
  cumulativeGasUsed: string;
  gasUsed: string;
  confirmations: string;
  methodId: string;
  functionName: string;
}
