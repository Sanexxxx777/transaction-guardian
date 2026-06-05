import { prisma } from './index.js';
import { DEFAULT_NETWORKS, DEFAULT_PROTOCOLS } from '../config/networks.js';
import { createLogger } from '../utils/logger.js';

const logger = createLogger('seed');

export async function seedNetworks(): Promise<void> {
  logger.info('Seeding networks...');

  for (const network of DEFAULT_NETWORKS) {
    await prisma.network.upsert({
      where: { chainId: network.chainId },
      update: {
        name: network.name,
        shortName: network.shortName,
        safeTxServiceUrl: network.safeTxServiceUrl,
        tenderlyNetworkId: network.tenderlyNetworkId,
        explorerUrl: network.explorerUrl,
        nativeCurrencySymbol: network.nativeCurrency.symbol,
        nativeCurrencyDecimals: network.nativeCurrency.decimals,
        nativeCurrencyCoingeckoId: network.nativeCurrency.coingeckoId,
      },
      create: {
        chainId: network.chainId,
        name: network.name,
        shortName: network.shortName,
        safeTxServiceUrl: network.safeTxServiceUrl,
        tenderlyNetworkId: network.tenderlyNetworkId,
        explorerUrl: network.explorerUrl,
        nativeCurrencySymbol: network.nativeCurrency.symbol,
        nativeCurrencyDecimals: network.nativeCurrency.decimals,
        nativeCurrencyCoingeckoId: network.nativeCurrency.coingeckoId,
        isEnabled: true,
      },
    });
  }

  logger.info(`Seeded ${DEFAULT_NETWORKS.length} networks`);
}

export async function seedProtocolWhitelist(): Promise<void> {
  logger.info('Seeding global protocol whitelist...');

  for (const [protocolName, addresses] of Object.entries(DEFAULT_PROTOCOLS)) {
    const existing = await prisma.protocolWhitelist.findFirst({
      where: {
        clientId: null,
        protocolName,
      },
    });

    if (existing) {
      await prisma.protocolWhitelist.update({
        where: { id: existing.id },
        data: { contractAddresses: addresses },
      });
    } else {
      await prisma.protocolWhitelist.create({
        data: {
          clientId: null,
          protocolName,
          contractAddresses: addresses,
          isActive: true,
        },
      });
    }
  }

  logger.info(`Seeded ${Object.keys(DEFAULT_PROTOCOLS).length} protocols`);
}

export async function runSeeds(): Promise<void> {
  try {
    await seedNetworks();
    await seedProtocolWhitelist();
    logger.info('All seeds completed');
  } catch (error) {
    logger.error({ error }, 'Seed failed');
    throw error;
  }
}

if (process.argv[1]?.endsWith('seed.ts') || process.argv[1]?.endsWith('seed.js')) {
  runSeeds()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}
