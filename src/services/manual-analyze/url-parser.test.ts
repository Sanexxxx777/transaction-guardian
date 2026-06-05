
import { parseSafeTxUrl, extractSafeUrls } from './url-parser.js';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string, detail?: unknown) {
  if (condition) {
    passed++;
    console.log(`✓ ${name}`);
  } else {
    failed++;
    console.log(`✗ ${name}`, detail ? JSON.stringify(detail, null, 2) : '');
  }
}

{
  const safeAddr = '0x1234567890AbcdEF1234567890aBCdef12345678';
  const txHash = '0x' + 'a'.repeat(64);
  const url = `https://app.safe.global/transactions/tx?safe=arb1:${safeAddr}&id=multisig_${safeAddr}_${txHash}`;
  const r = parseSafeTxUrl(url);
  assert(r.ok && r.value.chainId === 42161, 'arb1 → chainId 42161', r);
  assert(r.ok && r.value.safeAddress === safeAddr, 'safeAddress preserved', r);
  assert(r.ok && r.value.safeTxHash === txHash, 'safeTxHash preserved', r);
}

const chains: Array<[string, number]> = [
  ['eth', 1], ['arb1', 42161], ['base', 8453], ['oeth', 10],
  ['matic', 137], ['bnb', 56], ['avax', 43114], ['linea', 59144], ['mantle', 5000],
];
for (const [shortName, expectedChainId] of chains) {
  const safe = '0x' + '1'.repeat(40);
  const tx = '0x' + '2'.repeat(64);
  const url = `https://app.safe.global/transactions/tx?safe=${shortName}:${safe}&id=multisig_${safe}_${tx}`;
  const r = parseSafeTxUrl(url);
  assert(r.ok && r.value.chainId === expectedChainId, `${shortName} → chainId ${expectedChainId}`, r);
}

{
  const safe = '0x' + '3'.repeat(40);
  const tx = '0x' + '4'.repeat(64);
  const url = `https://app.safe.global/transactions/tx?safe=ETH:${safe}&id=multisig_${safe}_${tx}`;
  const r = parseSafeTxUrl(url);
  assert(r.ok && r.value.chainId === 1, 'mixed-case shortName', r);
}

{
  const safe = '0x' + '5'.repeat(40);
  const tx = '0x' + '6'.repeat(64);
  const url = `  https://app.safe.global/transactions/tx?safe=base:${safe}&id=multisig_${safe}_${tx}  `;
  const r = parseSafeTxUrl(url);
  assert(r.ok, 'leading/trailing whitespace', r);
}

{
  const r = parseSafeTxUrl('https://app.gnosis.io/transactions/tx?safe=eth:0x123&id=foo');
  assert(!r.ok && (r.error || '').includes('safe.global'), 'wrong host rejected', r);
}

{
  const safe = '0x' + '7'.repeat(40);
  const tx = '0x' + '8'.repeat(64);
  const url = `https://app.safe.global/welcome?safe=eth:${safe}`;
  const r = parseSafeTxUrl(url);
  assert(!r.ok, 'wrong path rejected', r);
}

{
  const r = parseSafeTxUrl('https://app.safe.global/transactions/tx?id=multisig_0x_0x');
  assert(!r.ok, 'missing safe= rejected', r);
}

{
  const safe = '0x' + 'a'.repeat(40);
  const tx = '0x' + 'b'.repeat(64);
  const url = `https://app.safe.global/transactions/tx?safe=zksync:${safe}&id=multisig_${safe}_${tx}`;
  const r = parseSafeTxUrl(url);
  assert(!r.ok && (r.error || '').includes('zksync'), 'unknown chain rejected', r);
}

{
  const safe1 = '0x' + 'a'.repeat(40);
  const safe2 = '0x' + 'b'.repeat(40);
  const tx = '0x' + 'c'.repeat(64);
  const url = `https://app.safe.global/transactions/tx?safe=eth:${safe1}&id=multisig_${safe2}_${tx}`;
  const r = parseSafeTxUrl(url);
  assert(!r.ok && (r.error || '').includes('не совпадают'), 'address mismatch rejected', r);
}

{
  const safe = '0x' + '1'.repeat(40);
  const url = `https://app.safe.global/transactions/tx?safe=eth:${safe}&id=multisig_${safe}_0xabc`;
  const r = parseSafeTxUrl(url);
  assert(!r.ok, 'short safeTxHash rejected', r);
}

{
  const r = parseSafeTxUrl('not a url');
  assert(!r.ok, 'plain text rejected', r);
}

{
  const safe = '0x' + '1'.repeat(40);
  const tx = '0x' + '2'.repeat(64);
  const text = `Чек это: https://app.safe.global/transactions/tx?safe=eth:${safe}&id=multisig_${safe}_${tx} спасибо`;
  const urls = extractSafeUrls(text);
  assert(urls.length === 1, 'extracts embedded URL', urls);
}

{
  const safe = '0x' + '1'.repeat(40);
  const tx1 = '0x' + 'a'.repeat(64);
  const tx2 = '0x' + 'b'.repeat(64);
  const text = `один https://app.safe.global/transactions/tx?safe=eth:${safe}&id=multisig_${safe}_${tx1}\nдва https://app.safe.global/transactions/tx?safe=arb1:${safe}&id=multisig_${safe}_${tx2}`;
  const urls = extractSafeUrls(text);
  assert(urls.length === 2, 'extracts multiple URLs', urls);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
