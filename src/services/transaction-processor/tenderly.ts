import axios, { AxiosInstance } from 'axios';
import { config } from '../../config/index.js';
import { createLogger } from '../../utils/logger.js';
import type { SimulationResult, AssetChange } from '../../models/transaction.js';

const logger = createLogger('tenderly');

interface TenderlySimulationRequest {
  network_id: string;
  from: string;
  to: string;
  value: string;
  input: string;
  save: boolean;
  save_if_fails: boolean;
  simulation_type: 'quick' | 'full';
}

interface TenderlySimulationResponse {
  transaction: {
    status: boolean;
    gas_used: number;
    error_message?: string;
    transaction_info: {
      asset_changes?: TenderlyAssetChange[];
      call_trace?: TenderlyCallTrace;
    };
  };
  contracts?: TenderlyContract[];
}

interface TenderlyAssetChange {
  type: 'Transfer' | 'Mint' | 'Burn';
  token_info?: {
    contract_address?: string;
    symbol?: string;
    decimals?: number;
    standard?: 'ERC20' | 'ERC721' | 'ERC1155' | 'NATIVE';
  };
  from?: string;
  to?: string;
  raw_amount?: string;
  dollar_value?: string;
}

interface TenderlyCallTrace {
  function_name?: string;
  input?: string;
  output?: string;
  calls?: TenderlyCallTrace[];
}

interface TenderlyContract {
  address: string;
  contract_name?: string;
  verified?: boolean;
}

export class TenderlyClient {
  private client: AxiosInstance;
  private isConfigured: boolean;

  constructor() {
    this.isConfigured = config.tenderly.isConfigured;

    if (this.isConfigured) {
      this.client = axios.create({
        baseURL: `https://api.tenderly.co/api/v1/account/${config.tenderly.accountSlug}/project/${config.tenderly.projectSlug}`,
        timeout: 60000,
        headers: {
          'X-Access-Key': config.tenderly.accessKey!,
          'Content-Type': 'application/json',
        },
      });
    } else {
      this.client = axios.create();
      logger.warn('Tenderly not configured - simulations will be skipped');
    }
  }

  async simulate(params: {
    networkId: string;
    from: string;
    to: string;
    value: string;
    data: string;
  }): Promise<SimulationResult> {
    if (!this.isConfigured) {
      return {
        success: true,
        assetChanges: [],
        logs: [],
      };
    }

    try {
      const request: TenderlySimulationRequest = {
        network_id: params.networkId,
        from: params.from,
        to: params.to,
        value: params.value,
        input: params.data || '0x',
        save: false,
        save_if_fails: false,
        simulation_type: 'full',
      };

      logger.debug({ from: params.from, to: params.to, networkId: params.networkId }, 'Running simulation');

      const response = await this.client.post<TenderlySimulationResponse>('/simulate', request);

      const result = this.parseSimulationResponse(response.data);

      logger.info(
        {
          success: result.success,
          gasUsed: result.gasUsed,
          assetChanges: result.assetChanges.length,
        },
        'Simulation completed'
      );

      return result;
    } catch (error) {
      logger.error({ error, params }, 'Simulation failed');

      if (axios.isAxiosError(error) && error.response?.data) {
        return {
          success: false,
          error: error.response.data.error?.message || 'Simulation failed',
          assetChanges: [],
          logs: [],
        };
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        assetChanges: [],
        logs: [],
      };
    }
  }

  private parseSimulationResponse(response: TenderlySimulationResponse): SimulationResult {
    const tx = response.transaction;

    const assetChanges: AssetChange[] = (tx.transaction_info.asset_changes || []).map((change) => ({
      type: change.token_info?.standard === 'NATIVE' ? 'native' :
            change.token_info?.standard === 'ERC721' ? 'erc721' :
            change.token_info?.standard === 'ERC1155' ? 'erc1155' : 'erc20',
      tokenAddress: change.token_info?.standard !== 'NATIVE' ? change.token_info?.contract_address : undefined,
      tokenSymbol: change.token_info?.symbol || 'UNKNOWN',
      tokenDecimals: change.token_info?.decimals ?? 18,
      from: change.from || '',
      to: change.to || '',
      amount: change.raw_amount || '0',
      amountUsd: change.dollar_value ? parseFloat(change.dollar_value) : undefined,
    }));

    return {
      success: tx.status,
      gasUsed: tx.gas_used,
      error: tx.error_message,
      assetChanges,
      logs: [],
    };
  }

  async isContractVerified(address: string, networkId: string): Promise<boolean> {
    if (!this.isConfigured) {
      return true;
    }

    try {
      const response = await this.client.get(`/contract/${networkId}/${address}`);
      return response.data?.verified === true;
    } catch {
      return false;
    }
  }
}

let tenderlyClient: TenderlyClient | null = null;

export function getTenderlyClient(): TenderlyClient {
  if (!tenderlyClient) {
    tenderlyClient = new TenderlyClient();
  }
  return tenderlyClient;
}
