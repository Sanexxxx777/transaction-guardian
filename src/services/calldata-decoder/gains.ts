
export const GAINS_SELECTORS = {
  OPEN_TRADE: '0xd6246605',
  OPEN_TRADE_NATIVE: '0xcb43166d',
  CLOSE_TRADE_MARKET: '0x36ce736b',
} as const;

export interface GainsDecodeResult {
  protocol: 'Gains Trade';
  method: string;
  recipient: string | null;
  isImplicitSender: boolean;
}

export function isGainsMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return Object.values(GAINS_SELECTORS).includes(selector as typeof GAINS_SELECTORS[keyof typeof GAINS_SELECTORS]);
}

export function decodeGains(data: string, safeAddress: string): GainsDecodeResult | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();

  switch (selector) {
    case GAINS_SELECTORS.OPEN_TRADE:
      return {
        protocol: 'Gains Trade',
        method: 'openTrade',
        recipient: safeAddress,
        isImplicitSender: true,
      };

    case GAINS_SELECTORS.OPEN_TRADE_NATIVE:
      return {
        protocol: 'Gains Trade',
        method: 'openTradeNative',
        recipient: safeAddress,
        isImplicitSender: true,
      };

    case GAINS_SELECTORS.CLOSE_TRADE_MARKET:
      return {
        protocol: 'Gains Trade',
        method: 'closeTradeMarket',
        recipient: safeAddress,
        isImplicitSender: true,
      };

    default:
      return null;
  }
}
