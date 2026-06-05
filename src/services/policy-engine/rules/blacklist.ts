import axios from 'axios';
import { prisma } from '../../../db/index.js';
import { createLogger } from '../../../utils/logger.js';
import { addressEquals } from '../../../utils/address.js';
import type { PolicyViolation, PolicyCheckInput } from '../../../models/policy.js';

const logger = createLogger('blacklist-check');

let blacklistCache: Set<string> = new Set();
let lastFetchTime = 0;
const CACHE_TTL = 3600000;

const KNOWN_SCAM_ADDRESSES: string[] = [
  '0x098b716b8aaf21512996dc57eb0615e2383e2f96',
  '0xa0e1c89ef1a489c9c7de96311ed5ce5d32c20e4b',
  '0x3cffd56b47b7b41c56258d9c7731abadc360e073',
  '0x53f8f6f9f6e3b2f1b6b7e5c3c0e8f6e5d4c3b2a1',
  '0x629e7da20197a5429d30da36e77d06cdf796b71a',
  '0x56d8b635a7c88fd1104d23d632af40c1c3aac4e3',
  '0x00000000a50bb64b4bbeceb18715748dface08af',
  '0x000000000035b5e5ad9019092c665357240f594e',
];

const SCAM_LABELS: Record<string, string> = {
  '0x098b716b8aaf21512996dc57eb0615e2383e2f96': 'Lazarus Group (OFAC)',
  '0xa0e1c89ef1a489c9c7de96311ed5ce5d32c20e4b': 'Lazarus Group',
  '0x629e7da20197a5429d30da36e77d06cdf796b71a': 'Wormhole Exploiter',
  '0x56d8b635a7c88fd1104d23d632af40c1c3aac4e3': 'Nomad Bridge Exploiter',
};

async function fetchExternalBlacklist(): Promise<void> {
  try {
    const response = await axios.get(
      'https://api.chainabuse.com/v0/addresses',
      { timeout: 5000 }
    );

    if (response.data?.addresses) {
      for (const addr of response.data.addresses) {
        blacklistCache.add(addr.toLowerCase());
      }
    }
  } catch (error) {
    logger.debug({ error }, 'Failed to fetch external blacklist');
  }
}

async function getBlacklist(clientId?: string): Promise<Set<string>> {
  const now = Date.now();

  if (blacklistCache.size === 0) {
    for (const addr of KNOWN_SCAM_ADDRESSES) {
      blacklistCache.add(addr.toLowerCase());
    }
  }

  if (now - lastFetchTime > CACHE_TTL) {
    lastFetchTime = now;
    fetchExternalBlacklist().catch(() => {});
  }

  const dbBlacklist = await prisma.addressWhitelist.findMany({
    where: {
      isActive: true,
      label: { startsWith: 'BLACKLIST:' }
    },
    select: { address: true }
  });

  for (const entry of dbBlacklist) {
    blacklistCache.add(entry.address.toLowerCase());
  }

  if (clientId) {
    const whitelistedAddresses = await prisma.addressWhitelist.findMany({
      where: {
        isActive: true,
        label: { not: { startsWith: 'BLACKLIST:' } },
        OR: [{ clientId: null }, { clientId }],
      },
      select: { address: true },
    });

    const whiteset = new Set(whitelistedAddresses.map(a => a.address.toLowerCase()));
    if (whiteset.size > 0) {
      const filtered = new Set<string>();
      for (const addr of blacklistCache) {
        if (!whiteset.has(addr)) {
          filtered.add(addr);
        }
      }
      return filtered;
    }
  }

  return blacklistCache;
}

export async function checkBlacklist(
  input: PolicyCheckInput
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  const { transaction, detectedRecipient, clientId } = input;

  const blacklist = await getBlacklist(clientId);

  const toAddr = transaction.to.toLowerCase();
  if (blacklist.has(toAddr)) {
    const label = SCAM_LABELS[toAddr] || 'Известный скам-адрес';
    violations.push({
      ruleId: 'BLACKLISTED_ADDRESS',
      severity: 'danger',
      title: '🚫 Адрес в чёрном списке',
      description: `${label}. НЕ ОТПРАВЛЯЙТЕ средства!`,
      details: {
        address: transaction.to,
        label,
      },
    });
  }

  if (detectedRecipient && !addressEquals(detectedRecipient, transaction.to)) {
    const recipientLower = detectedRecipient.toLowerCase();
    if (blacklist.has(recipientLower)) {
      const label = SCAM_LABELS[recipientLower] || 'Известный скам-адрес';
      violations.push({
        ruleId: 'BLACKLISTED_RECIPIENT',
        severity: 'danger',
        title: '🚫 Получатель в чёрном списке',
        description: `${label}. Средства уйдут на скам-адрес!`,
        details: {
          recipient: detectedRecipient,
          label,
        },
      });
    }
  }

  return violations;
}

export function addToBlacklist(address: string, label?: string): void {
  blacklistCache.add(address.toLowerCase());
  if (label) {
    SCAM_LABELS[address.toLowerCase()] = label;
  }
}
