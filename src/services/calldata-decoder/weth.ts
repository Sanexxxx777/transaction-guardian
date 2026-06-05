
const WETH_ADDRESSES: Record<number, string> = {
  1:     '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  42161: '0x82aF49447D8a07e3bd95BD0d56f35241523fBab1',
  10:    '0x4200000000000000000000000000000000000006',
  8453:  '0x4200000000000000000000000000000000000006',
  137:   '0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270',
};

const WETH_SELECTORS = {
  DEPOSIT:  '0xd0e30db0',
  WITHDRAW: '0x2e1a7d4d',
};

export function isWethContract(to: string, chainId?: number): boolean {
  const addr = to.toLowerCase();
  for (const weth of Object.values(WETH_ADDRESSES)) {
    if (weth.toLowerCase() === addr) return true;
  }
  return false;
}

export function isWethMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return selector === WETH_SELECTORS.DEPOSIT || selector === WETH_SELECTORS.WITHDRAW;
}

export function decodeWeth(
  data: string,
  safeAddress: string,
): { recipient: string | null; protocol: string; method: string; isImplicitSender: boolean } | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  if (selector === WETH_SELECTORS.DEPOSIT) {
    return {
      recipient: null,
      protocol: 'WETH',
      method: 'wethDeposit',
      isImplicitSender: true,
    };
  }

  if (selector === WETH_SELECTORS.WITHDRAW) {
    return {
      recipient: safeAddress,
      protocol: 'WETH',
      method: 'wethWithdraw',
      isImplicitSender: true,
    };
  }

  return null;
}

export { WETH_ADDRESSES };
