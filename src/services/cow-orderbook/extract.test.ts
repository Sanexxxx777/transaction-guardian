
import { extractOrderUids, extractInvalidateOrderUids } from './index.js';

let passed = 0;
let failed = 0;

function assert(cond: boolean, name: string, detail?: unknown) {
  if (cond) { passed++; console.log(`✓ ${name}`); }
  else { failed++; console.log(`✗ ${name}`, detail ? JSON.stringify(detail) : ''); }
}

function buildSetPreSignatureCalldata(uid56hex: string, signed = true): string {
  const selector = 'ec6cb13f';
  const offset = '40'.padStart(64, '0');
  const signedHex = (signed ? '01' : '00').padStart(64, '0');
  const lengthHex = '38'.padStart(64, '0');
  const uidPadded = uid56hex.padEnd(128, '0');
  return '0x' + selector + offset + signedHex + lengthHex + uidPadded;
}

{
  const uid = 'a'.repeat(112);
  const data = buildSetPreSignatureCalldata(uid);
  const out = extractOrderUids(data);
  assert(out.length === 1, 'direct: 1 orderUid extracted', out);
  assert(out[0] === '0x' + uid, 'direct: matches input UID', out);
}

{
  const uid = 'B'.repeat(112);
  const data = buildSetPreSignatureCalldata(uid).toUpperCase();
  const out = extractOrderUids(data);
  assert(out.length === 1, 'mixed-case: 1 orderUid extracted', out);
  assert(out[0] === '0x' + uid.toLowerCase(), 'mixed-case: lowercased', out);
}

{
  const uid = 'c'.repeat(112);
  const inner = buildSetPreSignatureCalldata(uid).slice(2);

  const wrapped = '0x8d80ff0a' + 'deadbeef'.repeat(20) + inner + 'beefdead'.repeat(10);
  const out = extractOrderUids(wrapped);
  assert(out.length === 1, 'multisend: extracted from wrapper', out);
  assert(out[0] === '0x' + uid, 'multisend: UID matches', out);
}

{
  const uid1 = '1'.repeat(112);
  const uid2 = '2'.repeat(112);
  const inner1 = buildSetPreSignatureCalldata(uid1).slice(2);
  const inner2 = buildSetPreSignatureCalldata(uid2).slice(2);
  const data = '0x8d80ff0a' + inner1 + 'aaaa' + inner2;
  const out = extractOrderUids(data);
  assert(out.length === 2, 'multisend: two orderUids', out);
  assert(out[0] === '0x' + uid1 && out[1] === '0x' + uid2, 'multisend: order preserved', out);
}

{
  const uid = 'd'.repeat(112);
  const inner = buildSetPreSignatureCalldata(uid).slice(2);
  const data = '0x' + inner + inner;
  const out = extractOrderUids(data);
  assert(out.length === 1, 'duplicate uids deduped', out);
}

{
  const data = '0x' + 'ec6cb13f' + '00'.repeat(64) + 'ff'.repeat(56);
  const out = extractOrderUids(data);
  assert(out.length === 0, 'false-positive rejected (bad length field)', out);
}

{
  const out = extractOrderUids('0xa9059cbb000000000000000000000000abcdef');
  assert(out.length === 0, 'erc20 transfer: no CoW orders', out);
}

{
  assert(extractOrderUids('').length === 0, 'empty string', null);
  assert(extractOrderUids('0x').length === 0, '0x only', null);
}

function buildInvalidateOrderCalldata(uid56hex: string): string {
  const selector = '2689f0a7';
  const offset = '20'.padStart(64, '0');
  const lengthHex = '38'.padStart(64, '0');
  const uidPadded = uid56hex.padEnd(128, '0');
  return '0x' + selector + offset + lengthHex + uidPadded;
}

{
  const uid = 'b'.repeat(112);
  const data = buildInvalidateOrderCalldata(uid);
  const out = extractInvalidateOrderUids(data);
  assert(out.length === 1, 'invalidate: 1 orderUid extracted', out);
  assert(out[0] === '0x' + uid, 'invalidate: matches input UID', { expected: uid, got: out[0] });

  assert(extractOrderUids(data).length === 0, 'invalidate: not picked up by setPreSignature extractor', null);
}

{
  const uid = 'c'.repeat(112);
  const inner = buildInvalidateOrderCalldata(uid).slice(2);
  const multisendData = '0x8d80ff0a' + 'deadbeef' + inner;
  const out = extractInvalidateOrderUids(multisendData);
  assert(out.length === 1, 'invalidate multisend: extracted from wrapper', out);
  assert(out[0] === '0x' + uid, 'invalidate multisend: UID matches', null);
}

{
  const uidCreate = 'd'.repeat(112);
  const uidCancel = 'e'.repeat(112);
  const innerCreate = buildSetPreSignatureCalldata(uidCreate).slice(2);
  const innerCancel = buildInvalidateOrderCalldata(uidCancel).slice(2);
  const multisendData = '0x8d80ff0a' + 'beef' + innerCreate + innerCancel;
  const creates = extractOrderUids(multisendData);
  const cancels = extractInvalidateOrderUids(multisendData);
  assert(creates.length === 1 && creates[0] === '0x' + uidCreate, 'mixed: create uid picked up by setPreSignature extractor', creates);
  assert(cancels.length === 1 && cancels[0] === '0x' + uidCancel, 'mixed: cancel uid picked up by invalidateOrder extractor', cancels);
}

{
  const selector = '2689f0a7';
  const offset = '20'.padStart(64, '0');
  const badLen = '40'.padStart(64, '0');
  const uidPadded = 'f'.repeat(112).padEnd(128, '0');
  const data = '0x' + selector + offset + badLen + uidPadded;
  const out = extractInvalidateOrderUids(data);
  assert(out.length === 0, 'invalidate false-positive rejected (bad length)', out);
}

{
  assert(extractInvalidateOrderUids('').length === 0, 'invalidate empty', null);
  assert(extractInvalidateOrderUids('0xa9059cbb').length === 0, 'invalidate on erc20 transfer', null);
}

console.log(`\n${passed}/${passed + failed} passed`);
process.exit(failed > 0 ? 1 : 0);
