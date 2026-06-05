import axios from 'axios';
import { createLogger } from '../../../utils/logger.js';
import { isProtocolWhitelisted } from '../whitelist.js';
import type { PolicyViolation, PolicyCheckInput } from '../../../models/policy.js';

const logger = createLogger('contract-check');

const contractCache = new Map<string, ContractInfo | null>();
const CACHE_TTL = 3600000;
const CACHE_MAX_SIZE = 500;

function evictExpiredCache(): void {
  if (contractCache.size <= CACHE_MAX_SIZE) return;
  const now = Date.now();
  for (const [key, value] of contractCache) {
    if (!value || now - value.fetchedAt > CACHE_TTL) {
      contractCache.delete(key);
    }
  }

  if (contractCache.size > CACHE_MAX_SIZE) {
    const entries = Array.from(contractCache.entries())
      .sort((a, b) => (a[1]?.fetchedAt || 0) - (b[1]?.fetchedAt || 0));
    const toDelete = entries.slice(0, contractCache.size - CACHE_MAX_SIZE);
    for (const [key] of toDelete) {
      contractCache.delete(key);
    }
  }
}

interface ContractInfo {
  verified: boolean;
  contractName?: string;
  creationDate?: Date;
  creatorAddress?: string;
  fetchedAt: number;
}

const TRUSTED_DEPLOYERS = new Set([
  '0x4e1dcf7ad4e460cfd30791ccc4f9c8a4f820ec67',
  '0xa6b71e26c5e0845f74c812102ca7114b6a896ab2',
  '0x76e2cfc1f5fa8f6a5b3fc4c8f4788d0657516f91',
  '0x50e55af101c777ba7a1d560a774a82ef002ced9',
  '0x1122fD9eBB2a8E7c181Cc77705E7eB5De4ef9BD',
].map(a => a.toLowerCase()));

const ETHERSCAN_V2_URL = 'https://api.etherscan.io/v2/api';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || '';

const SUPPORTED_CHAINS = new Set([1, 42161, 137, 10, 8453, 56, 43114, 59144]);

async function getContractInfo(address: string, chainId: number): Promise<ContractInfo | null> {
  const cacheKey = `${chainId}:${address.toLowerCase()}`;

  const cached = contractCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL) {
    return cached;
  }

  if (!ETHERSCAN_API_KEY) return null;

  try {
    const sourceResponse = await axios.get(ETHERSCAN_V2_URL, {
      params: {
        chainid: chainId,
        module: 'contract',
        action: 'getsourcecode',
        address,
        apikey: ETHERSCAN_API_KEY,
      },
      timeout: 8000,
    });

    if (sourceResponse.data?.status !== '1' || !Array.isArray(sourceResponse.data?.result)) {
      logger.debug({ address, chainId, msg: sourceResponse.data?.result }, 'Etherscan V2: getsourcecode returned non-OK');
      return null;
    }

    const isVerified = !!(sourceResponse.data.result[0]?.SourceCode &&
                          sourceResponse.data.result[0].SourceCode !== '');
    const contractName = sourceResponse.data.result[0]?.ContractName || undefined;

    let creationDate: Date | undefined;
    let creatorAddress: string | undefined;

    try {
      const creationResponse = await axios.get(ETHERSCAN_V2_URL, {
        params: {
          chainid: chainId,
          module: 'contract',
          action: 'getcontractcreation',
          contractaddresses: address,
          apikey: ETHERSCAN_API_KEY,
        },
        timeout: 8000,
      });

      if (creationResponse.data?.status === '1' && Array.isArray(creationResponse.data?.result) &&
          creationResponse.data.result[0]) {
        creatorAddress = creationResponse.data.result[0].contractCreator;
        const txHash = creationResponse.data.result[0].txHash;
        if (txHash) {
          const txResponse = await axios.get(ETHERSCAN_V2_URL, {
            params: {
              chainid: chainId,
              module: 'proxy',
              action: 'eth_getTransactionByHash',
              txhash: txHash,
              apikey: ETHERSCAN_API_KEY,
            },
            timeout: 8000,
          });

          if (txResponse.data?.result?.blockNumber) {
            const blockResponse = await axios.get(ETHERSCAN_V2_URL, {
              params: {
                chainid: chainId,
                module: 'block',
                action: 'getblockreward',
                blockno: parseInt(txResponse.data.result.blockNumber, 16),
                apikey: ETHERSCAN_API_KEY,
              },
              timeout: 8000,
            });

            if (blockResponse.data?.result?.timeStamp) {
              creationDate = new Date(parseInt(blockResponse.data.result.timeStamp) * 1000);
            }
          }
        }
      }
    } catch (e) {
      logger.debug({ address, chainId }, 'Could not fetch contract creation info');
    }

    const info: ContractInfo = {
      verified: isVerified,
      contractName,
      creationDate,
      creatorAddress,
      fetchedAt: Date.now(),
    };

    contractCache.set(cacheKey, info);
    evictExpiredCache();
    return info;
  } catch (error) {
    logger.debug({ error, address, chainId }, 'Failed to fetch contract info');
    return null;
  }
}

async function isContract(address: string, chainId: number): Promise<boolean> {
  if (!ETHERSCAN_API_KEY) return false;

  try {
    const response = await axios.get(ETHERSCAN_V2_URL, {
      params: {
        chainid: chainId,
        module: 'proxy',
        action: 'eth_getCode',
        address,
        tag: 'latest',
        apikey: ETHERSCAN_API_KEY,
      },
      timeout: 8000,
    });

    return !!(response.data?.result && response.data.result !== '0x');
  } catch {
    return false;
  }
}

export async function checkContract(
  input: PolicyCheckInput
): Promise<PolicyViolation[]> {
  const violations: PolicyViolation[] = [];
  const { transaction } = input;

  if (!ETHERSCAN_API_KEY || !SUPPORTED_CHAINS.has(transaction.chainId)) {
    return violations;
  }

  const protocolCheck = isProtocolWhitelisted(transaction.to, transaction.chainId, input.effectiveWhitelists);
  if (protocolCheck.whitelisted) {
    logger.debug({ address: transaction.to, protocol: protocolCheck.protocolName }, 'Contract in protocol whitelist, skipping verification check');
    return violations;
  }

  const toIsContract = await isContract(transaction.to, transaction.chainId);
  if (!toIsContract) {
    return violations;
  }

  const contractInfo = await getContractInfo(transaction.to, transaction.chainId);
  if (!contractInfo) {
    return violations;
  }

  if (!contractInfo.verified) {
    const deployedByTrusted = contractInfo.creatorAddress
      && TRUSTED_DEPLOYERS.has(contractInfo.creatorAddress.toLowerCase());

    if (!deployedByTrusted) {
      violations.push({
        ruleId: 'UNVERIFIED_CONTRACT',
        severity: 'warning',
        title: '⚠️ Контракт не верифицирован',
        description: 'Исходный код не опубликован. Невозможно проверить что делает контракт.',
        details: {
          address: transaction.to,
        },
      });
    }
  }

  if (contractInfo.creationDate) {
    const ageMs = Date.now() - contractInfo.creationDate.getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);

    if (ageDays < 7) {
      violations.push({
        ruleId: 'NEW_CONTRACT',
        severity: 'warning',
        title: '🆕 Новый контракт',
        description: `Контракт создан ${ageDays < 1 ? 'менее суток' : Math.floor(ageDays) + ' дней'} назад. Будьте осторожны.`,
        details: {
          address: transaction.to,
          createdAt: contractInfo.creationDate.toISOString(),
          ageDays: Math.floor(ageDays),
        },
      });
    }
  }

  return violations;
}
