// Webhook authentication: accept the common ways senders prove they know a
// source's secret. Many platforms only offer a "签名密钥" field and sign the
// body with HMAC instead of sending the secret itself, so we verify signatures
// too instead of rejecting them as "missing secret".
import crypto from 'node:crypto';
import { safeEqual, sha256 } from './util.js';

const DIRECT_HEADERS = [
  'x-pushhub-secret',
  'x-webhook-secret',
  'x-secret',
  'x-api-key',
  'x-auth-token',
  'x-token',
];

const SIGN_HEADERS = [
  'x-signature',
  'x-sign',
  'signature',
  'sign',
  'x-hub-signature-256',
  'x-hub-signature',
  'x-webhook-signature',
  'x-pushhub-signature',
];

const DIRECT_QUERY = ['token', 'secret', 'key', 'apikey', 'api_key'];
const SIGN_QUERY = ['sign', 'signature'];
const TIMESTAMP_HEADERS = ['x-timestamp', 'x-request-timestamp', 'timestamp', 'x-timestamp-ms', 'x-webhook-timestamp', 't'];
const TIMESTAMP_QUERY = ['timestamp', 'ts', 't'];

function decodeSafe(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function normalizeSig(value) {
  let s = String(value ?? '').trim();
  s = decodeSafe(s);
  // "sha256=..." / "sha1=..." prefixes
  if (/^sha(?:1|256)=/i.test(s)) s = s.replace(/^sha(?:1|256)=/i, '');
  // Stripe style "t=...,v1=..."
  const v1 = /(?:^|,)\s*v1=([A-Za-z0-9+/=_-]+)/.exec(s);
  if (v1) s = v1[1];
  return s.trim();
}

function hmacVariants(alg, key, data) {
  const h = crypto.createHmac(alg, key).update(data).digest();
  return [h.toString('hex'), h.toString('base64'), h.toString('base64url')];
}

function matchAny(hexOrB64Variants, sig) {
  const candidates = [sig, sig.toLowerCase()];
  for (const v of hexOrB64Variants) {
    for (const c of candidates) if (safeEqual(v, c)) return true;
  }
  return false;
}

function verifySignature(value, secret, raw, timestamps) {
  if (!secret) return false;
  const sig = normalizeSig(value);
  if (!sig) return false;

  const dataList = [raw];
  for (const ts of timestamps) {
    if (!ts) continue;
    // 常见：timestamp + "." / "\n" / 直接拼接 + body
    dataList.push(`${ts}.${raw}`, `${ts}\n${raw}`, `${ts}${raw}`, `${raw}${ts}`);
    // 飞书 / 钉钉风格：以 timestamp+"\n"+secret 作为 key，签名空串或 secret
    if (matchAny(hmacVariants('sha256', `${ts}\n${secret}`, ''), sig)) return true;
    if (matchAny(hmacVariants('sha256', secret, `${ts}\n${secret}`), sig)) return true;
    if (matchAny(hmacVariants('sha256', secret, `${ts}.${secret}`), sig)) return true;
  }

  for (const data of dataList) {
    if (matchAny(hmacVariants('sha256', secret, data), sig)) return true;
    if (matchAny(hmacVariants('sha1', secret, data), sig)) return true;
  }

  // 少数老平台用 MD5(secret + body)
  const md5a = crypto.createHash('md5').update(secret + raw).digest('hex');
  if (matchAny([md5a], sig)) return true;
  const md5b = crypto.createHash('md5').update(raw + secret).digest('hex');
  return matchAny([md5b], sig);
}

export function collectHeaderNames(req) {
  return Object.keys(req.headers).sort();
}

/** 安全的请求头摘要：密钥类只显示掩码，签名类显示前 18 个字符便于判断算法。 */
export function safeHeaderSummary(req) {
  const out = {};
  const sensitive = new Set(['authorization', 'cookie', ...DIRECT_HEADERS]);
  for (const [name, value] of Object.entries(req.headers)) {
    const v = Array.isArray(value) ? value.join(',') : String(value ?? '');
    if (sensitive.has(name)) {
      out[name] = '***';
    } else if (SIGN_HEADERS.includes(name)) {
      out[name] = v.length > 18 ? v.slice(0, 18) + '…' : v;
    } else if (['content-type', 'content-length', 'user-agent', 'host', 'x-forwarded-for', 'x-real-ip', ...TIMESTAMP_HEADERS].includes(name)) {
      out[name] = v.slice(0, 160);
    } else {
      out[name] = v ? `(${v.length} chars)` : '';
    }
  }
  return out;
}

/**
 * @returns {{ok: true, method: string}}
 * @throws {Error & {status:number}} when nothing matches
 */
export function verifyWebhookAuth(req, url, source, rawBuf, parsedBody) {
  const secret = source?.secret || '';
  const devKey = source?.key || '';
  const raw = Buffer.isBuffer(rawBuf) ? rawBuf.toString('utf8') : String(rawBuf ?? '');

  const direct = [];
  for (const h of DIRECT_HEADERS) {
    const v = req.headers[h];
    if (v) direct.push({ name: `header:${h}`, value: String(v) });
  }
  if (req.headers.authorization) {
    direct.push({ name: 'authorization', value: req.headers.authorization.replace(/^Bearer\s+/i, '') });
  }
  for (const q of DIRECT_QUERY) {
    const v = url.searchParams.get(q);
    if (v) direct.push({ name: `query:${q}`, value: v });
  }
  // 有些平台把「签名密钥」原样塞进 x-signature / sign 参数
  for (const h of SIGN_HEADERS) {
    const v = req.headers[h];
    if (v) direct.push({ name: `header:${h}`, value: String(v) });
  }
  for (const q of SIGN_QUERY) {
    const v = url.searchParams.get(q);
    if (v) direct.push({ name: `query:${q}`, value: v });
  }

  if (secret) {
    for (const c of direct) {
      if (safeEqual(c.value, secret) || safeEqual(c.value, devKey)) return { ok: true, method: c.name };
      // ntfy 风格：把 sha256(secret) 当作密钥
      if (source.secretHash && safeEqual(sha256(c.value), source.secretHash)) return { ok: true, method: `${c.name} (sha256)` };
      if (safeEqual(sha256(c.value), sha256(secret))) return { ok: true, method: `${c.name} (sha256)` };
    }
  }

  const sigs = [];
  for (const h of SIGN_HEADERS) {
    const v = req.headers[h];
    if (v) sigs.push({ name: `header:${h}`, value: String(v) });
  }
  for (const q of SIGN_QUERY) {
    const v = url.searchParams.get(q);
    if (v) sigs.push({ name: `query:${q}`, value: v });
  }
  if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
    if (parsedBody.sign) sigs.push({ name: 'body:sign', value: String(parsedBody.sign) });
    if (parsedBody.signature) sigs.push({ name: 'body:signature', value: String(parsedBody.signature) });
  }

  const timestamps = [];
  for (const h of TIMESTAMP_HEADERS) {
    if (req.headers[h]) timestamps.push(String(req.headers[h]));
  }
  for (const q of TIMESTAMP_QUERY) {
    const v = url.searchParams.get(q);
    if (v) timestamps.push(v);
  }
  if (parsedBody && typeof parsedBody === 'object' && parsedBody.timestamp !== undefined) {
    timestamps.push(String(parsedBody.timestamp));
  }

  if (secret) {
    for (const s of sigs) {
      if (verifySignature(s.value, secret, raw, timestamps)) return { ok: true, method: `signature:${s.name}` };
    }
  }

  const hasCredential = direct.length > 0 || sigs.length > 0;
  if (!hasCredential) {
    const hint =
      '缺少来源密钥或签名：请在平台里把「签名密钥」填成来源密钥，' +
      `或调用时加 header x-pushhub-secret / Authorization: Bearer，或 URL 加 ?token=<来源密钥>。` +
      (source ? `（来源 ${source.id}）` : '');
    throw Object.assign(new Error(hint), { status: 401 });
  }
  throw Object.assign(
    new Error('来源密钥/签名校验失败：收到了凭据但无法匹配。可在控制台「接入诊断」查看收到的请求头，确认平台使用的签名算法。'),
    { status: 401 }
  );
}