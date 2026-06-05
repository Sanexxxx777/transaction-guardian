import { prisma } from '../../db/index.js';
import { redis, isRedisAvailable } from '../../db/redis.js';
import { config } from '../../config/index.js';
import { getSafeApiClient } from '../wallet-monitor/safe-api.js';
import { addressEquals, addressInList } from '../../utils/address.js';
import type { EffectiveWhitelists, ProtocolWhitelistEntry, AddressWhitelistEntry } from '../../models/policy.js';

const SAFE_OWNERS_CACHE_TTL = 86400;

async function getSafeOwners(safeAddress: string, chainId: number): Promise<string[]> {
  const cacheKey = `safe_owners:${chainId}:${safeAddress.toLowerCase()}`;

  if (isRedisAvailable()) {
    try {
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as string[];
    } catch {  }
  }

  try {
    const network = await prisma.network.findUnique({ where: { chainId } });
    if (!network) return [];

    const client = getSafeApiClient(chainId, network.safeTxServiceUrl, config.safe.apiKey || undefined);
    const safeInfo = await client.getSafeInfo(safeAddress);
    if (!safeInfo?.owners?.length) return [];

    const owners = safeInfo.owners;

    if (isRedisAvailable()) {
      try {
        await redis.set(cacheKey, JSON.stringify(owners), 'EX', SAFE_OWNERS_CACHE_TTL);
      } catch {  }
    }

    return owners;
  } catch {
    return [];
  }
}

export async function getEffectiveWhitelists(clientId: string): Promise<EffectiveWhitelists> {
  const globalProtocols = await prisma.protocolWhitelist.findMany({
    where: { clientId: null, isActive: true },
  });

  const clientProtocols = await prisma.protocolWhitelist.findMany({
    where: { clientId, isActive: true },
  });

  const globalAddresses = await prisma.addressWhitelist.findMany({
    where: { clientId: null, isActive: true },
  });

  const clientAddresses = await prisma.addressWhitelist.findMany({
    where: { clientId, isActive: true },
  });

  const clientWallets = await prisma.wallet.findMany({
    where: { clientId, isActive: true },
    select: { address: true, chainId: true, name: true, type: true },
  });

  const autoWhitelistedAddresses: AddressWhitelistEntry[] = clientWallets.map((w) => ({
    id: `auto-wallet-${w.address}`,
    address: w.address,
    label: w.name || 'Мой кошелёк',
    chainIds: [w.chainId],
    isGlobal: false,
  }));

  const safeWallets = clientWallets.filter(w => w.type === 'safe');
  const ownerAddressMap = new Map<string, { label: string; chainId: number }>();
  await Promise.allSettled(
    safeWallets.map(async (safeWallet) => {
      const owners = await getSafeOwners(safeWallet.address, safeWallet.chainId);
      for (const owner of owners) {
        const key = owner.toLowerCase();
        if (!ownerAddressMap.has(key)) {
          ownerAddressMap.set(key, {
            label: `Подписант Safe ${safeWallet.address}`,
            chainId: safeWallet.chainId,
          });
        }
      }
    })
  );
  const autoWhitelistedOwners: AddressWhitelistEntry[] = Array.from(ownerAddressMap.entries()).map(
    ([address, { label }]) => ({
      id: `auto-owner-${address}`,
      address,
      label,
      chainIds: [],
      isGlobal: false,
      isSafeOwner: true,
    })
  );

  const autoWhitelistedProtocol: ProtocolWhitelistEntry = {
    id: 'auto-client-wallets',
    protocolName: 'Мои кошельки',
    contractAddresses: {},
    isGlobal: false,
  };

  for (const wallet of clientWallets) {
    if (!autoWhitelistedProtocol.contractAddresses[wallet.chainId]) {
      autoWhitelistedProtocol.contractAddresses[wallet.chainId] = [];
    }
    autoWhitelistedProtocol.contractAddresses[wallet.chainId].push(wallet.address.toLowerCase());
  }

  const enabledNetworks = await prisma.network.findMany({ where: { isEnabled: true }, select: { chainId: true } });
  for (const [ownerAddr] of ownerAddressMap.entries()) {
    for (const net of enabledNetworks) {
      if (!autoWhitelistedProtocol.contractAddresses[net.chainId]) {
        autoWhitelistedProtocol.contractAddresses[net.chainId] = [];
      }
      autoWhitelistedProtocol.contractAddresses[net.chainId].push(ownerAddr);
    }
  }

  const protocols: ProtocolWhitelistEntry[] = [
    ...globalProtocols.map((p) => ({
      id: p.id,
      protocolName: p.protocolName,
      contractAddresses: p.contractAddresses as Record<number, string[]>,
      isGlobal: true,
    })),
    ...clientProtocols.map((p) => ({
      id: p.id,
      protocolName: p.protocolName,
      contractAddresses: p.contractAddresses as Record<number, string[]>,
      isGlobal: false,
    })),

    autoWhitelistedProtocol,
  ];

  const addresses: AddressWhitelistEntry[] = [
    ...globalAddresses.map((a) => ({
      id: a.id,
      address: a.address,
      label: a.label,
      chainIds: a.chainIds,
      isGlobal: true,
    })),
    ...clientAddresses.map((a) => ({
      id: a.id,
      address: a.address,
      label: a.label,
      chainIds: a.chainIds,
      isGlobal: false,
    })),

    ...autoWhitelistedAddresses,
    ...autoWhitelistedOwners,
  ];

  return { protocols, addresses };
}

export function isProtocolWhitelisted(
  address: string,
  chainId: number,
  whitelists: EffectiveWhitelists
): { whitelisted: boolean; protocolName: string | null } {
  for (const protocol of whitelists.protocols) {
    let chainAddresses: string[] = [];

    if (Array.isArray(protocol.contractAddresses)) {
      chainAddresses = protocol.contractAddresses;
    } else if (protocol.contractAddresses && typeof protocol.contractAddresses === 'object') {
      chainAddresses = protocol.contractAddresses[chainId] || [];
    }

    if (addressInList(address, chainAddresses)) {
      return { whitelisted: true, protocolName: protocol.protocolName };
    }
  }
  return { whitelisted: false, protocolName: null };
}

export function isAddressWhitelisted(
  address: string,
  chainId: number,
  whitelists: EffectiveWhitelists
): { whitelisted: boolean; label: string | null; isSafeOwner: boolean } {
  for (const entry of whitelists.addresses) {
    const chainAllowed = entry.chainIds.length === 0 || entry.chainIds.includes(chainId);
    if (chainAllowed && addressEquals(address, entry.address)) {
      return { whitelisted: true, label: entry.label, isSafeOwner: !!entry.isSafeOwner };
    }
  }
  return { whitelisted: false, label: null, isSafeOwner: false };
}

export async function isSafeWallet(address: string, chainId: number): Promise<boolean> {
  const wallet = await prisma.wallet.findFirst({
    where: {
      address: { equals: address, mode: 'insensitive' },
      chainId,
      isActive: true,
    },
  });
  return wallet !== null;
}
