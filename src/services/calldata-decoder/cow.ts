
const COW_SELECTORS: Record<string, string> = {
  '0xec6cb13f': 'setPreSignature',
  '0x2689f0a7': 'invalidateOrder',
  '0x13d79a0b': 'settle',
  '0x845a101f': 'swap',
};

const COW_SETTLEMENT = '0x9008d19f58aabd9ed0d60971565aa8510560ab41';
const COW_VAULT = '0xc92e8bdf79f0507f65a392b0ab4667716bfe0110';

export function isCowContract(to: string): boolean {
  const addr = to.toLowerCase();
  return addr === COW_SETTLEMENT || addr === COW_VAULT;
}

export function isCowMethod(data: string): boolean {
  if (!data || data.length < 10) return false;
  const selector = data.slice(0, 10).toLowerCase();
  return selector in COW_SELECTORS;
}

export function decodeCow(
  data: string,
  safeAddress: string,
): { recipient: string | null; protocol: string; method: string; isImplicitSender: boolean; confidence: 'high' | 'medium' | 'low' } | null {
  if (!data || data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase();
  const method = COW_SELECTORS[selector];
  if (!method) return null;

  return {
    recipient: safeAddress || null,
    protocol: 'CoW Protocol',
    method,
    isImplicitSender: true,
    confidence: 'medium',
  };
}

export function isCowExpectedRevert(errorMessage: string | undefined): boolean {
  if (!errorMessage) return false;
  const lower = errorMessage.toLowerCase();
  return lower.includes('gpv2') || lower.includes('presign') || lower.includes('cannot presign');
}
