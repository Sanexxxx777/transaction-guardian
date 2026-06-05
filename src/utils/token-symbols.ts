
const SYMBOL_NORMALIZE: Record<string, string> = {
  'BSC-USD': 'USDT',
  'BSC-USDC': 'USDC',
};

export function normalizeTokenSymbol(symbol: string | null | undefined): string {
  if (!symbol) return 'TOKEN';
  const upper = symbol.toUpperCase();
  return SYMBOL_NORMALIZE[upper] || upper;
}
