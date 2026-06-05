
const SAFE_SHORT_NAME_TO_CHAIN_ID: Record<string, number> = {
  eth: 1,
  arb1: 42161,
  base: 8453,
  oeth: 10,
  matic: 137,
  bnb: 56,
  avax: 43114,
  linea: 59144,
  mantle: 5000,
};

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SAFE_TX_HASH_RE = /^0x[a-fA-F0-9]{64}$/;

export interface ParsedSafeUrl {
  chainId: number;
  safeAddress: string;
  safeTxHash: string;
}

export type ParseResult =
  | { ok: true; value: ParsedSafeUrl }
  | { ok: false; error: string };

export function parseSafeTxUrl(input: string): ParseResult {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return { ok: false, error: 'Невалидный URL' };
  }

  if (!/(^|\.)safe\.global$/i.test(url.hostname)) {
    return { ok: false, error: `Ожидаю ссылку на app.safe.global, получил ${url.hostname}` };
  }

  if (!url.pathname.startsWith('/transactions/tx')) {
    return { ok: false, error: 'URL не похож на ссылку на конкретную транзакцию (/transactions/tx)' };
  }

  const safeParam = url.searchParams.get('safe');
  const idParam = url.searchParams.get('id');

  if (!safeParam || !idParam) {
    return { ok: false, error: 'В URL отсутствуют параметры safe= и/или id=' };
  }

  const [shortName, safeAddrFromQuery] = safeParam.split(':');
  if (!shortName || !safeAddrFromQuery) {
    return { ok: false, error: `Параметр safe= должен быть в формате shortName:0xAddress (получил: ${safeParam})` };
  }

  const chainId = SAFE_SHORT_NAME_TO_CHAIN_ID[shortName.toLowerCase()];
  if (!chainId) {
    return {
      ok: false,
      error: `Неизвестная сеть "${shortName}". Поддерживаются: ${Object.keys(SAFE_SHORT_NAME_TO_CHAIN_ID).join(', ')}`,
    };
  }

  if (!ADDRESS_RE.test(safeAddrFromQuery)) {
    return { ok: false, error: `Невалидный адрес Safe в параметре safe=: ${safeAddrFromQuery}` };
  }

  if (!idParam.startsWith('multisig_')) {
    return {
      ok: false,
      error: 'Параметр id= не похож на multisig-транзакцию (ожидаю id=multisig_...)',
    };
  }

  const idParts = idParam.slice('multisig_'.length).split('_');
  if (idParts.length !== 2) {
    return { ok: false, error: 'Параметр id= имеет неожиданный формат' };
  }

  const [safeAddrFromId, safeTxHash] = idParts;
  if (!ADDRESS_RE.test(safeAddrFromId)) {
    return { ok: false, error: `Невалидный адрес Safe в id=: ${safeAddrFromId}` };
  }
  if (!SAFE_TX_HASH_RE.test(safeTxHash)) {
    return { ok: false, error: `Невалидный safeTxHash: ${safeTxHash}` };
  }

  if (safeAddrFromQuery.toLowerCase() !== safeAddrFromId.toLowerCase()) {
    return {
      ok: false,
      error: 'Адрес Safe в параметрах safe= и id= не совпадают (ссылка повреждена?)',
    };
  }

  return {
    ok: true,
    value: {
      chainId,
      safeAddress: safeAddrFromQuery,
      safeTxHash,
    },
  };
}

const SAFE_URL_PATTERN = /https?:\/\/[\w.-]*safe\.global\/transactions\/tx\?[^\s]+/gi;

export function extractSafeUrls(text: string): string[] {
  const matches = text.match(SAFE_URL_PATTERN);
  return matches ? matches.map(s => s.trim()) : [];
}
