import { Interface } from 'ethers';

const AURA_BOOSTER_ABI = [
  'function deposit(uint256 _pid, uint256 _amount, bool _stake) external returns (bool)',
];

const AURA_LOCKER_ABI = [
  'function lock(address _account, uint256 _amount) external',
  'function getReward(address _account) external',
];

const AURA_STAKING_ABI = [
  'function stakeFor(address _for, uint256 _amount) external',
];

const auraBoosterInterface = new Interface(AURA_BOOSTER_ABI);
const auraLockerInterface = new Interface(AURA_LOCKER_ABI);
const auraStakingInterface = new Interface(AURA_STAKING_ABI);

export const AURA_SELECTORS = {
  DEPOSIT: '0x43a0d066',
  LOCK: '0x282d3fdf',
  GET_REWARD: '0xc00007b0',
  STAKE_FOR: '0x2ee40908',
} as const;

export interface AuraDecodeResult {
  protocol: 'AURA';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isAuraMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(AURA_SELECTORS).includes(selector as typeof AURA_SELECTORS[keyof typeof AURA_SELECTORS]);
}

export function decodeAura(data: string, safeAddress: string): AuraDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  try {
    switch (selector) {
      case AURA_SELECTORS.DEPOSIT: {
        return {
          protocol: 'AURA',
          method: 'deposit',
          recipient: safeAddress,
          isImplicitSender: true,
        };
      }

      case AURA_SELECTORS.LOCK: {
        const decoded = auraLockerInterface.decodeFunctionData('lock', data);
        const account = decoded[0] as string;
        return {
          protocol: 'AURA',
          method: 'lock',
          recipient: account,
          isImplicitSender: false,
        };
      }

      case AURA_SELECTORS.GET_REWARD: {
        const decoded = auraLockerInterface.decodeFunctionData('getReward', data);
        const account = decoded[0] as string;
        return {
          protocol: 'AURA',
          method: 'getReward',
          recipient: account,
          isImplicitSender: false,
        };
      }

      case AURA_SELECTORS.STAKE_FOR: {
        const decoded = auraStakingInterface.decodeFunctionData('stakeFor', data);
        const forAddr = decoded[0] as string;
        return {
          protocol: 'AURA',
          method: 'stakeFor',
          recipient: forAddr,
          isImplicitSender: false,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}
