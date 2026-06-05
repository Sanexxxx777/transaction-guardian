import type { ProcessedTransaction, WalletType } from '../../models/transaction.js';

export interface RawTransaction {
  txHash?: string;

  safeTxHash?: string;

  walletType: WalletType;

  chainId: number;

  walletAddress: string;

  from: string;

  to: string;

  value: string;

  data: string | null;

  blockNumber?: number;
}

export interface IWalletMonitorStrategy {
  readonly walletType: WalletType;

  checkWallet(
    walletId: string,
    address: string,
    chainId: number,
  ): Promise<void>;

  start(): Promise<void>;

  stop(): void;
}
