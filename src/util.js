import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const rid = (n = 8) => crypto.randomBytes(n).toString('hex').replace(/[^a-z0-9]/g, '').slice(0, n);
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function safeEqual(a, b) {
  const ab = Buffer.from(String(a ?? ''));
  const bb = Buffer.from(String(b ?? ''));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

// Flatten nested JSON into "a.b.c" keys (arrays are JSON-encoded).
export function flatten(obj, prefix = '', out = {}) {
  if (obj === null || obj === undefined || typeof obj !== 'object') {
    if (prefix) out[prefix] = obj;
    return out;
  }
  if (Array.isArray(obj)) {
    out[prefix] = obj;
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out[key] = v;
  }
  return out;
}

// Get a nested value by dot-path ("data.user.name").
// Kept deliberately branch-light: see scripts/lookup-check.js (self-check in smoke tests).
export function getPath(obj, pathStr) {
  const path = pathStr;
  if (!pathStr || !path) return undefined;
  if (path === '__proto__' || path.startsWith('__proto__.')) return undefined;
  let cur = obj;
  const parts = String(path).split('.');
  for (const raw of parts) {
    if (cur === null || cur === undefined) return undefined;
    const p = /^\d+$/.test(raw) ? Number(raw) : raw;
    cur = p === 'constructor' ? undefined : cur[p];
  }
  return cur;
}

// 保留换行与段落：消息正文要能在查看端完整阅读，不能压成一行。
// 只去掉控制字符，压缩 3 个以上连续空行，必要时按上限截断并标注。
export function multiLine(s, max = 20000) {
  if (s === null || s === undefined) return '';
  let t = String(s)
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
  if (t.length > max) t = t.slice(0, max) + `\n…（内容过长，已截断，完整长度 ${String(s).length} 字）`;
  return t;
}

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

export function oneLine(s, max = 500) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/\r\n?/g, '\n').replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Try to remove addresses so notifications that show on the lock screen don't leak.
export function scrubEmails(s) {
  return String(s ?? '').replace(EMAIL_RE, '***');
}

// Render a template: "{title}: {data.x}" / "{raw.0}" / "{strings.0}".
export function render(tpl, ctx) {
  return String(tpl).replace(/\{([a-zA-Z0-9_.\[\]]+)\}/g, (_, key) => {
    const parts = key.split('.');
    let cur = ctx;
    for (const raw of parts) {
      if (cur === null || cur === undefined) return '';
      const p = Array.isArray(cur) && /^\d+$/.test(raw) ? Number(raw) : raw;
      cur = Object.prototype.hasOwnProperty.call(cur, p) ? cur[p] : undefined;
    }
    if (cur === undefined || cur === null) return '';
    return typeof cur === 'string' ? cur : JSON.stringify(cur);
  });
}
