import { Interface } from 'ethers';

const LIDO_STETH_ABI = [
  'function submit(address _referral) external payable returns (uint256)',
];

const LIDO_WITHDRAWAL_ABI = [
  'function requestWithdrawals(uint256[] _amounts, address _owner) external returns (uint256[])',
  'function claimWithdrawals(uint256[] _requestIds, uint256[] _hints) external',
];

const lidoStethInterface = new Interface(LIDO_STETH_ABI);
const lidoWithdrawalInterface = new Interface(LIDO_WITHDRAWAL_ABI);

export const LIDO_SELECTORS = {
  SUBMIT: '0xa1903eab',
  REQUEST_WITHDRAWALS: '0xd6681042',
  CLAIM_WITHDRAWALS: '0xe3afe0a3',
} as const;

export interface LidoDecodeResult {
  protocol: 'Lido';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isLidoMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(LIDO_SELECTORS).includes(selector as typeof LIDO_SELECTORS[keyof typeof LIDO_SELECTORS]);
}

export function decodeLido(data: string, safeAddress: string): LidoDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case LIDO_SELECTORS.SUBMIT: {
        return {
          protocol: 'Lido',
          method: 'submit',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case LIDO_SELECTORS.REQUEST_WITHDRAWALS: {
        const decoded = lidoWithdrawalInterface.decodeFunctionData('requestWithdrawals', data);
        const owner = decoded[1] as string;
        return {
          protocol: 'Lido',
          method: 'requestWithdrawals',
          recipient: owner,
          isImplicitSender: false,
        };
      }

      case LIDO_SELECTORS.CLAIM_WITHDRAWALS: {
        return {
          protocol: 'Lido',
          method: 'claimWithdrawals',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
