
export interface ClientPolicy {
  id: string;
  clientId: string;
  maxTransactionUsd: string | null;
  dailyLimitUsd: string | null;
  blockUnlimitedApprovals: boolean;
  maxApprovalUsd: string | null;
  warnUnknownContracts: boolean;
  blockUnknownContracts: boolean;
}

export interface EffectiveWhitelists {
  protocols: ProtocolWhitelistEntry[];
  addresses: AddressWhitelistEntry[];
}

export interface ProtocolWhitelistEntry {
  id: string;
  protocolName: string;
  contractAddresses: Record<number, string[]>;
  isGlobal: boolean;
}

export interface AddressWhitelistEntry {
  id: string;
  address: string;
  label: string | null;
  chainIds: number[];
  isGlobal: boolean;

  isSafeOwner?: boolean;
}

export interface PolicyCheckInput {
  transaction: {
    from: string;
    to: string;
    value: string;
    data: string | null;
    chainId: number;
  };
  simulationResult?: {
    success: boolean;
    assetChanges: Array<{
      type: string;
      tokenAddress?: string;
      tokenSymbol?: string;
      from: string;
      to: string;
      amount: string;
      amountUsd?: number;
    }>;
  };
  clientPolicy: ClientPolicy | null;
  effectiveWhitelists: EffectiveWhitelists;
  decodedMethod?: string;
  decodedParams?: Record<string, unknown>;
  detectedRecipient?: string;
  detectedProtocol?: string;
  dailySpentUsd?: number;
  clientId?: string;

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
  }>;
}

export interface PolicyCheckResult {
  riskLevel: 'ok' | 'info' | 'warning' | 'danger';
  violations: PolicyViolation[];
}

export interface PolicyViolation {
  ruleId: PolicyRuleId;
  severity: 'info' | 'warning' | 'danger';
  title: string;
  description: string;
  details?: Record<string, unknown>;
}

export type PolicyRuleId =
  | 'AMOUNT_EXCEEDED'
  | 'DAILY_LIMIT_EXCEEDED'
  | 'UNLIMITED_APPROVAL'
  | 'UNLIMITED_APPROVAL_UNKNOWN'
  | 'HIGH_APPROVAL'
  | 'UNVERIFIED_CONTRACT'
  | 'DELEGATECALL'
  | 'CONTRACT_UPGRADE'
  | 'UNKNOWN_PROTOCOL'
  | 'UNKNOWN_RECIPIENT'
  | 'CALLDATA_RECIPIENT_MISMATCH'
  | 'RECIPIENT_EXTERNAL_WHITELISTED'
  | 'RECIPIENT_UNKNOWN'
  | 'SIMULATION_FAILED'

  | 'BLACKLISTED_ADDRESS'
  | 'BLACKLISTED_RECIPIENT'
  | 'NEW_CONTRACT'
  | 'AMOUNT_ANOMALY'
  | 'SIMILAR_ADDRESS'
  | 'UNKNOWN_METHOD'
  | 'RECIPIENT_INVALID'

  | 'COW_CUSTOM_RECEIVER'
  | 'COW_APPROVE_MISMATCH'
  | 'COW_ORDER_DEAD'
  | 'COW_PRICE_ANOMALY'

  | 'SAFE_OWNER_ADDED'
  | 'SAFE_OWNER_REMOVED'
  | 'SAFE_OWNER_SWAPPED'
  | 'SAFE_THRESHOLD_LOWERED'
  | 'SAFE_THRESHOLD_RAISED'
  | 'SAFE_THRESHOLD_SINGLE_SIG'
  | 'SAFE_MODULE_ENABLED'
  | 'SAFE_MODULE_DISABLED'
  | 'SAFE_GUARD_SET'
  | 'SAFE_GUARD_REMOVED';
