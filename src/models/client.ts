
export interface ClientWithWallets {
  id: string;
  name: string;
  telegramChatId: bigint;
  notes: string | null;
  createdAt: Date;
  wallets: WalletInfo[];
}

export interface WalletInfo {
  id: string;
  address: string;
  chainId: number;
  name: string | null;
  isActive: boolean;
}

export interface ClientSummary {
  id: string;
  name: string;
  walletsCount: number;
  chatId: bigint;
}

export interface AdminUser {
  id: string;
  telegramUserId: bigint;
  telegramUsername: string | null;
  name: string | null;
}
