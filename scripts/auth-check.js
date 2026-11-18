// Webhook 认证回归：直接密钥、query、常见 HMAC 签名形态。
import crypto from 'node:crypto';
import { verifyWebhookAuth } from '../src/webauth.js';

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  console.log((cond ? '  ✓ ' : '  ✗ ') + name + (cond ? '' : ' ' + extra));
  cond ? pass++ : fail++;
};
const hmac = (alg, key, data, enc = 'hex') => crypto.createHmac(alg, key).update(data).digest(enc);

const SECRET = 'test-secret-0123456789abcdef';
const KEY = 'devkey01';
const source = { id: 'manual', secret: SECRET, key: KEY };
const bodyText = '{"title":"签名消息","text":"hello"}';
const raw = Buffer.from(bodyText, 'utf8');

function req(headers = {}) {
  return { headers, socket: { remoteAddress: '::ffff:127.0.0.1' } };
}
function run(headers, queries = {}, parsed = null) {
  const url = new URL('http://x/hook/manual');
  for (const [k, v] of Object.entries(queries)) url.searchParams.set(k, v);
  return verifyWebhookAuth(req(headers), url, source, raw, parsed ?? JSON.parse(bodyText));
}
function expectOk(name, fn) {
  try {
    const r = fn();
    ok(name, !!r.ok, JSON.stringify(r));
  } catch (e) {
    ok(name, false, e.message);
  }
}
function expectFail(name, fn) {
  try {
    fn();
    ok(name, false, 'unexpectedly accepted');
  } catch (e) {
    ok(name, true);
  }
}

expectOk('direct x-pushhub-secret', () => run({ 'x-pushhub-secret': SECRET }));
expectOk('direct authorization bearer', () => run({ authorization: `Bearer ${SECRET}` }));
expectOk('query token', () => run({}, { token: SECRET }));
expectOk('query sign=secret', () => run({}, { sign: SECRET }));
expectOk('x-signature raw secret', () => run({ 'x-signature': SECRET }));

const hex = hmac('sha256', SECRET, bodyText);
const b64 = hmac('sha256', SECRET, bodyText, 'base64');
expectOk('hmac sha256 hex in x-signature', () => run({ 'x-signature': hex }));
expectOk('hmac sha256 hex with sha256= prefix', () => run({ 'x-signature': 'sha256=' + hex }));
expectOk('hmac sha256 base64', () => run({ 'x-signature': b64 }));
expectOk('hmac sha256 hex in x-hub-signature-256', () => run({ 'x-hub-signature-256': 'sha256=' + hex }));

const ts = '1794970000';
expectOk('hmac timestamp.body', () => run({ 'x-signature': hmac('sha256', SECRET, `${ts}.${bodyText}`), 'x-timestamp': ts }));
expectOk('hmac timestamp\\nbody', () => run({ 'x-signature': hmac('sha256', SECRET, `${ts}\n${bodyText}`), 'timestamp': ts }));
expectOk('hmac body+timestamp', () => run({ 'x-signature': hmac('sha256', SECRET, `${bodyText}${ts}`), 'x-timestamp': ts }));

// 飞书风格：body {timestamp, sign}，sign = base64(HMAC-SHA256(key=timestamp+"\n"+secret, data=""))
const feishuSign = crypto.createHmac('sha256', `${ts}\n${SECRET}`).update('').digest('base64');
const feishuBody = { ...JSON.parse(bodyText), timestamp: ts, sign: feishuSign };
expectOk('feishu body sign', () =>
  verifyWebhookAuth(req({}), new URL('http://x/hook/manual'), source, Buffer.from(JSON.stringify(feishuBody)), feishuBody)
);

expectFail('wrong signature rejected', () => run({ 'x-signature': hmac('sha256', 'wrong', bodyText) }));
expectFail('no credentials rejected', () => run({}));
expectFail('bad direct secret rejected', () => run({ 'x-pushhub-secret': 'nope' }));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);