import { prisma } from '../../db/index.js';

export interface TierLimits {
  maxWallets: number;
  allowedChainIds: number[] | null;
  aiAnalysis: boolean;
  simulation: boolean;
  policyEngine: boolean;
}

const FULL_ACCESS: TierLimits = {
  maxWallets: 100,
  allowedChainIds: null,
  aiAnalysis: true,
  simulation: true,
  policyEngine: true,
};

export function getTierLimits(_tier?: string): TierLimits {
  return FULL_ACCESS;
}

export async function checkCanAddWallet(clientId: string): Promise<{ allowed: boolean; reason?: string }> {
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { id: true },
  });
  if (!client) return { allowed: false, reason: 'Client not found' };

  const currentCount = await prisma.wallet.count({
    where: { clientId, isActive: true },
  });

  if (currentCount >= FULL_ACCESS.maxWallets) {
    return { allowed: false, reason: `Max wallets: ${FULL_ACCESS.maxWallets}` };
  }

  return { allowed: true };
}

export async function checkNetworkAllowed(_clientId: string, _chainId: number): Promise<boolean> {
  return true;
}

export function isAiAllowed(_tier?: string): boolean {
  return true;
}

export function isSimulationAllowed(_tier?: string): boolean {
  return true;
}

export function getTierDisplayName(_tier?: string): string {
  return 'Full Access';
}
