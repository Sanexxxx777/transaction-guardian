import { Interface } from 'ethers';

const SAFE_ABI = [
  'function addOwnerWithThreshold(address owner, uint256 _threshold)',
  'function removeOwner(address prevOwner, address owner, uint256 _threshold)',
  'function swapOwner(address prevOwner, address oldOwner, address newOwner)',
  'function changeThreshold(uint256 _threshold)',
  'function enableModule(address module)',
  'function disableModule(address prevModule, address module)',
  'function setGuard(address guard)',
  'function approveHash(bytes32 hashToApprove)',
];

const safeIface = new Interface(SAFE_ABI);

const SAFE_SELECTORS = {
  ADD_OWNER: '0x0d582f13',
  REMOVE_OWNER: '0xf8dc5dd9',
  SWAP_OWNER: '0xe318b52b',
  CHANGE_THRESHOLD: '0x694e80c3',
  ENABLE_MODULE: '0x610b5925',
  DISABLE_MODULE: '0xe009cfde',
  SET_GUARD: '0xe19a9dd9',
  APPROVE_HASH: '0xd4d9bdcd',
} as const;

export type SafeAdminMethod =
  | 'addOwnerWithThreshold'
  | 'removeOwner'
  | 'swapOwner'
  | 'changeThreshold'
  | 'enableModule'
  | 'disableModule'
  | 'setGuard'
  | 'approveHash';

export interface SafeAddOwnerResult {
  method: 'addOwnerWithThreshold';
  owner: string;
  threshold: number;
}

export interface SafeRemoveOwnerResult {
  method: 'removeOwner';
  prevOwner: string;
  owner: string;
  threshold: number;
}

export interface SafeSwapOwnerResult {
  method: 'swapOwner';
  prevOwner: string;
  oldOwner: string;
  newOwner: string;
}

export interface SafeChangeThresholdResult {
  method: 'changeThreshold';
  threshold: number;
}

export interface SafeEnableModuleResult {
  method: 'enableModule';
  module: string;
}

export interface SafeDisableModuleResult {
  method: 'disableModule';
  prevModule: string;
  module: string;
}

export interface SafeSetGuardResult {
  method: 'setGuard';
  guard: string;
}

export interface SafeApproveHashResult {
  method: 'approveHash';
  hash: string;
}

export type SafeAdminDecodeResult =
  | SafeAddOwnerResult
  | SafeRemoveOwnerResult
  | SafeSwapOwnerResult
  | SafeChangeThresholdResult
  | SafeEnableModuleResult
  | SafeDisableModuleResult
  | SafeSetGuardResult
  | SafeApproveHashResult;

export function isSafeAdminMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const sel = data.slice(0, 10).toLowerCase();
  return Object.values(SAFE_SELECTORS).includes(sel as typeof SAFE_SELECTORS[keyof typeof SAFE_SELECTORS]);
}

export function decodeSafeAdmin(data: string): SafeAdminDecodeResult | null {
  if (!data || data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase();
  try {
    switch (sel) {
      case SAFE_SELECTORS.ADD_OWNER: {
        const d = safeIface.decodeFunctionData('addOwnerWithThreshold', data);
        return {
          method: 'addOwnerWithThreshold',
          owner: d[0] as string,
          threshold: Number(d[1]),
        };
      }
      case SAFE_SELECTORS.REMOVE_OWNER: {
        const d = safeIface.decodeFunctionData('removeOwner', data);
        return {
          method: 'removeOwner',
          prevOwner: d[0] as string,
          owner: d[1] as string,
          threshold: Number(d[2]),
        };
      }
      case SAFE_SELECTORS.SWAP_OWNER: {
        const d = safeIface.decodeFunctionData('swapOwner', data);
        return {
          method: 'swapOwner',
          prevOwner: d[0] as string,
          oldOwner: d[1] as string,
          newOwner: d[2] as string,
        };
      }
      case SAFE_SELECTORS.CHANGE_THRESHOLD: {
        const d = safeIface.decodeFunctionData('changeThreshold', data);
        return { method: 'changeThreshold', threshold: Number(d[0]) };
      }
      case SAFE_SELECTORS.ENABLE_MODULE: {
        const d = safeIface.decodeFunctionData('enableModule', data);
        return { method: 'enableModule', module: d[0] as string };
      }
      case SAFE_SELECTORS.DISABLE_MODULE: {
        const d = safeIface.decodeFunctionData('disableModule', data);
        return {
          method: 'disableModule',
          prevModule: d[0] as string,
          module: d[1] as string,
        };
      }
      case SAFE_SELECTORS.SET_GUARD: {
        const d = safeIface.decodeFunctionData('setGuard', data);
        return { method: 'setGuard', guard: d[0] as string };
      }
      case SAFE_SELECTORS.APPROVE_HASH: {
        const d = safeIface.decodeFunctionData('approveHash', data);
        return { method: 'approveHash', hash: d[0] as string };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}
