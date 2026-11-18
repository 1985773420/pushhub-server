import http from 'node:http';
import { readRelease } from './apk.js';
import QRCode from 'qrcode';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Hub, publicSource } from './hub.js';
import { normalize, normalizeAttachments, normalizeBody, rawText, adaptNtfy, adaptBark, EMAIL_DEFAULTS } from './ingest.js';
import { initMedia, saveUpload, serveMedia, deleteMedia, maxUploadBytes } from './media.js';
import { nowIso, rid, sha256, safeEqual, oneLine } from './util.js';
import { verifyWebhookAuth, safeHeaderSummary } from './webauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const cfg = {
  port: Number(process.env.PORT || 8095),
  host: process.env.HOST || '0.0.0.0',
  dataFile: process.env.DATA_FILE || path.join(ROOT, 'data', 'pushhub.json'),
  adminToken: process.env.ADMIN_TOKEN || '',
  wsPath: process.env.WS_PATH || '/ws',
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  logBody: process.env.LOG_BODY === '1',
};
if (!cfg.adminToken || cfg.adminToken.length < 16) {
  console.error('[fatal] ADMIN_TOKEN env is required (>=16 chars). Generate one with: openssl rand -hex 24');
  process.exit(1);
}

const store = new Store(cfg.dataFile);
initMedia(path.join(path.dirname(cfg.dataFile), 'media'));

// Make sure the built-in sources exist: 'email' (connector mail) and 'manual' (scripts/curl).
function ensureDevSources() {
  const now = nowIso();
  let added = false;
  for (const preset of [
    { id: 'email', name: '邮箱', kind: 'email', color: '#E8735A', scrubEmails: true },
    { id: 'manual', name: '手动/脚本', kind: 'webhook', color: '#5B8DEF' },
  ]) {
    if (store.getSource(preset.id)) continue;
    store.data.sources.push({
      ...preset,
      enabled: true,
      defaultPriority: 'normal',
      fields: {},
      defaults: preset.kind === 'email' ? EMAIL_DEFAULTS : null,
      secret: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(8).toString('hex'),
      createdAt: now,
      count: 0,
      lastAt: null,
    });
    added = true;
  }
  if (added) {
    store.saveSync();
    console.log('[pushhub] seeded sources:', store.data.sources.map((s) => s.id).join(', '));
  }
  // 旧数据（或测试种子）里可能有短密钥；低于 16 字节的 secret 风险过高，启动时自动升级。
  let upgraded = 0;
  for (const s of store.data.sources) {
    if (typeof s.secret !== 'string' || s.secret.length < 16) {
      s.secret = crypto.randomBytes(16).toString('hex');
      upgraded++;
    }
    if (typeof s.key !== 'string' || s.key.length < 6) {
      s.key = crypto.randomBytes(8).toString('hex');
      upgraded++;
    }
  }
  if (upgraded) {
    store.saveSync();
    console.log(`[pushhub] upgraded ${upgraded} weak source secret(s); update your webhook clients`);
  }
}
ensureDevSources();
const hub = new Hub({ store });
const startedAt = Date.now();

// 最近 200 次 webhook 接入记录（内存），用于控制台「接入诊断」。
const activity = [];
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || String(req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
}
function recordActivity(entry) {
  activity.unshift({ ts: nowIso(), ...entry });
  if (activity.length > 200) activity.length = 200;
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

function send(res, status, obj, headers = {}) {
  const body = Buffer.from(JSON.stringify(obj));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.length,
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const bearer = (req) => (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
const adminOk = (req) => safeEqual(bearer(req), cfg.adminToken);

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const buf = await readBody(req);
  if (!buf.length) return {};
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid json');
  }
}

function baseUrl(req) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${cfg.port}`;
  return `${proto}://${host}`;
}

// Pairing addresses intentionally do not inherit PUBLIC_URL (webhook display only).
function pairUrl(value, field) {
  if (typeof value !== 'string') throw new HttpError(400, `${field} 必须是 HTTP/HTTPS 地址`);
  const text = value.trim();
  if (!text) return '';
  try {
    const u = new URL(text);
    if (!/^https?:\/\//i.test(text) || !['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password || text.includes('?') || text.includes('#') || /[\s\\]/.test(text)) throw new Error();
    return u.href.replace(/\/+$/, '');
  } catch { throw new HttpError(400, `${field} 必须是 HTTP/HTTPS 地址，可含端口和路径，不可含凭据、查询或片段`); }
}
function pairingBase(req, mode = 'local') {
  if (!['local', 'public'].includes(mode)) throw new HttpError(400, 'mode 必须是 local 或 public');
  if (mode === 'public') {
    if (!store.data.settings.publicPairUrl) throw new HttpError(400, '尚未配置公网配对地址，请在「设置」填写公网配对地址并保存');
    return pairUrl(store.data.settings.publicPairUrl, '公网配对地址');
  }
  return pairUrl(store.data.settings.localPairUrl || `${String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()}://${String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${cfg.port}`).split(',')[0].trim()}`, '内网配对地址');
}

function ingestReply(out) {
  if (out.result.ignored) return { ok: true, id: null, ignored: true, ...out.result };
  return { ok: true, id: out.msg.id, priority: out.msg.priority, source: out.msg.source, ...out.result };
}

const maskToken = (t) => (t ? `${t.slice(0, 4)}…${t.slice(-4)}` : '');

function deviceView(d) {
  return {
    id: d.id,
    name: d.name,
    createdAt: d.createdAt,
    lastSeenAt: d.lastSeenAt || null,
    lastOfflineAt: d.lastOfflineAt || null,
    lastError: d.lastError || null,
    lastErrorAt: d.lastErrorAt || null,
    lastIp: d.lastIp || null,
    online: hub.isOnline(d.id),
    pending: (d.pending || []).length,
    recipient: d.recipient || '',
    label: d.name || '',
    revokedAt: d.revokedAt || null,
    tokenMasked: maskToken(d.token),
    v: d.v || 1,
  };
}

function sourceView(s) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    color: s.color,
    enabled: s.enabled,
    defaultPriority: s.defaultPriority,
    createdAt: s.createdAt,
    lastAt: s.lastAt || null,
    count: s.count || 0,
    fields: s.fields || {},
    defaults: s.defaults || null,
    scrubEmails: !!s.scrubEmails,
    recipientIndex: s.recipientIndex,
    webhookUrl: null, // filled per request
    secretMasked: maskToken(s.secret),
  };
}

function findSourceById(id) {
  return store.getSource(id);
}

// Webhook auth: direct secret (common headers/query) or HMAC signature (see webauth.js).
function webhookAuth(req, url, source, rawBuf, parsedBody) {
  try {
    const r = verifyWebhookAuth(req, url, source, rawBuf, parsedBody);
    recordActivity({
      ok: true,
      source: source ? source.id : null,
      ip: clientIp(req),
      method: r.method,
      headers: safeHeaderSummary(req),
    });
    return r.method;
  } catch (e) {
    recordActivity({
      ok: false,
      source: source ? source.id : null,
      ip: clientIp(req),
      reason: e.message,
      headers: safeHeaderSummary(req),
      query: [...url.searchParams.keys()],
    });
    throw new HttpError(e.status || 401, e.message);
  }
}

// ---------------------------------------------------------------- core: ingest
function ingest({ source, body, req, special = {} }) {
  if (!source) throw new HttpError(404, 'unknown source');
  if (!source.enabled) throw new HttpError(403, 'source disabled');
  const msg = normalize(source, body, req, { ...special, recipient: special.recipient || (body && typeof body === 'object' ? oneLine(body.recipient ?? body.to ?? '', 200) : '') });
  if (!msg) return { msg: null, result: { sent: 0, queued: 0, offline: 0, ignored: true } };
  const full = {
    id: special.id || rid(10),
    ts: nowIso(),
    source: source.id,
    title: msg.title,
    body: msg.body,
    url: msg.url || '',
    image: msg.image || (msg.attachments || []).find((a) => a.type === 'image')?.url || '',
    attachments: msg.attachments || [],
    priority: special.priority || msg.priority,
    recipient: msg.recipient || '',
  };
  source.lastAt = full.ts;
  source.count = (source.count || 0) + 1;

  // Recipient allow-list (e.g. a webhook that serves many people).
  let devices;
  if (special.devices) devices = special.devices;
  else if (source.filterRecipient && full.recipient) {
    devices = store.data.devices.filter((d) => !d.revokedAt && (d.recipient || '') === full.recipient).map((d) => d.id);
  }
  if (devices && devices.length === 0) {
    store.saveSync();
    return { msg: full, result: { sent: 0, queued: 0, offline: 0, noTarget: true } };
  }

  const result = hub.deliver({ ...full, devices });

  if (cfg.logBody) console.log(`[ingest] ${source.id} ${full.title} -> sent=${result.sent} queued=${result.queued}`);
  return { msg: full, result };
}

// ---------------------------------------------------------------- static
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.apk': 'application/vnd.android.package-archive' };

function serveStatic(req, res, pathname) {
  if (/^\/PushHub(?:-[\w.-]+)?\.apk$/.test(pathname)) {
    let release;
    try { release = readRelease(ROOT, process.env.APK_RELEASE_DIR && /^\/PushHub-[\w.-]+-[a-f0-9]{64}\.apk$/.test(pathname) ? pathname.slice(1) : undefined); } catch { throw new HttpError(503, 'APK 发布信息缺失或校验失败'); }
    const { metadata, bytes } = release;
    if (pathname !== '/PushHub.apk' && pathname !== '/' + metadata.filename && pathname !== '/' + metadata.storageFilename) return false;
    res.writeHead(200, { 'content-type': MIME['.apk'], 'content-length': bytes.length, 'content-disposition': `attachment; filename="${metadata.filename}"`, 'cache-control': 'no-store', etag: `"${metadata.sha256}"` });
    res.end(req.method === 'HEAD' ? undefined : bytes);
    return true;
  }
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.resolve(path.join(ROOT, 'public'), `.${p}`);
  if (!file.startsWith(path.join(ROOT, 'public'))) return false;
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return false;
  }
  if (!st.isFile()) return false;
  const ext = path.extname(file);
  const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'content-length': st.size, 'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=300' };
  if (ext === '.apk') Object.assign(headers, { 'content-disposition': 'attachment; filename="PushHub.apk"' });
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

// ---------------------------------------------------------------- router
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const pathname = decodeURIComponent(url.pathname);
  const m = req.method;
  try {
    // ---------- health / version
    if (pathname === '/api/health') {
      return send(res, 200, {
        ok: true,
        server: 'pushhub',
        version: '1.0.0',
        dev: process.env.DEV_MODE === '1',
        time: nowIso(),
        uptime: Math.round((Date.now() - startedAt) / 1000),
        devices: store.data.devices.filter((d) => !d.revokedAt).length,
        online: store.data.devices.filter((d) => !d.revokedAt && hub.isOnline(d.id)).length,
        sources: store.data.sources.length,
        messages: store.data.messages.length,
      });
    }

    // ---------- app pairing (no admin auth, proof = a valid pairing code)
    if (pathname === '/api/pair' && m === 'POST') {
      const body = await readJson(req);
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      const now = Date.now();
      const pairing = store.data.pairings.find((p) => p.codeHash === sha256(code) && !p.usedAt && Date.parse(p.expiresAt) > now);
      if (!pairing) throw new HttpError(401, '配对码无效或已过期');
      const deviceName = oneLine(body.deviceName || 'Android', 60);
      const token = crypto.randomBytes(24).toString('hex');
      const device = {
        id: rid(8),
        name: deviceName,
        token,
        recipient: oneLine(body.recipient || pairing.recipient || '', 200),
        createdAt: nowIso(),
        lastSeenAt: null,
        pending: [],
        v: 1,
      };
      await store.mutate((d) => {
        const p = d.pairings.find((x) => x.id === pairing.id);
        if (!p || p.usedAt || Date.parse(p.expiresAt) <= Date.now()) throw new HttpError(401, '配对码无效或已过期');
        p.usedAt = nowIso();
        d.devices.push(device);
        if (d.devices.length > 50) d.devices.splice(0, d.devices.length - 50);
      });
      return send(res, 200, {
        deviceId: device.id,
        deviceToken: token,
        serverUrl: pairing.serverUrl || pairingBase(req),
        wsPath: cfg.wsPath,
        sources: store.data.sources.map(publicSource),
        name: device.name,
      });
    }

    if (pathname === '/api/receipts' && m === 'POST') {
      const device = store.data.devices.find(d => !d.revokedAt && safeEqual(d.token, bearer(req)));
      if (!device) throw new HttpError(401, 'unauthorized');
      const b = await readJson(req);
      if (!['received', 'opened', 'confirmed'].includes(b.status) || typeof b.id !== 'string') throw new HttpError(400, 'invalid receipt');
      if (!store.receipt(device, b.id, b.status)) throw new HttpError(404, 'targeted message not found');
      return send(res, 200, { ok: true });
    }

    // ---------- device history: GET /api/messages?token=<device token>&limit=100
    if (pathname === '/api/messages' && m === 'GET') {
      const token = url.searchParams.get('token') || '';
      const device = token
        ? store.data.devices.find((d) => !d.revokedAt && safeEqual(d.token, token))
        : null;
      if (!device) throw new HttpError(401, 'unauthorized');
      const id = url.searchParams.get('id') || '';
      if (id) {
        const msg = store.data.messages.find((x) => x.id === id
          && (x.devices ? x.devices.includes(device.id) : (!device.recipient || !x.recipient || x.recipient === device.recipient)));
        if (!msg) throw new HttpError(404, 'message not found');
        return send(res, 200, {
          ok: true,
          message: { id: msg.id, ts: msg.ts, source: msg.source, title: msg.title, body: msg.body, url: msg.url || '', image: msg.image || '', attachments: msg.attachments || [], priority: msg.priority },
        });
      }
      const limit = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 100));
      const messages = store.data.messages
        .filter((x) => x.devices ? x.devices.includes(device.id) : (!device.recipient || !x.recipient || x.recipient === device.recipient))
        .slice(0, limit)
        .map((x) => ({ id: x.id, ts: x.ts, source: x.source, title: x.title, body: x.body, url: x.url || '', image: x.image || '', attachments: x.attachments || [], priority: x.priority }));
      return send(res, 200, { ok: true, messages });
    }

    // ---------- generic webhook: /hook/:sourceId[?token=secret]
    let mm = pathname.match(/^\/hook\/([a-zA-Z0-9_-]+)$/);
    if (mm && (m === 'POST' || m === 'PUT')) {
      const source = findSourceById(mm[1]);
      const raw = await readBody(req);
      const body = normalizeBody(raw);
      webhookAuth(req, url, source, raw, body);
      const out = ingest({ source, body, req });
      return send(res, 202, ingestReply(out));
    }

    // ---------- ntfy style: PUBLISH /ntfy/:sourceId[/topic]  (JSON body and/or query params)
    mm = pathname.match(/^\/ntfy\/([a-zA-Z0-9_-]+)(?:\/[^/]*)?$/);
    if (mm) {
      if (m === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-pushhub-secret, cache, firebase', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' });
        return res.end();
      }
      const source = findSourceById(mm[1]);
      let raw = Buffer.alloc(0);
      let body = {};
      if (m === 'POST' || m === 'PUT') {
        raw = await readBody(req);
        if (raw.length) body = normalizeBody(raw);
      }
      webhookAuth(req, url, source, raw, body);
      const adapted = adaptNtfy(Object.fromEntries(url.searchParams.entries()), body);
      const merged = adapted.body;
      const special = adapted.special;
      const out = ingest({ source, body: merged, req, special });
      return send(res, 200, ingestReply(out), { 'access-control-allow-origin': '*' });
    }

    // ---------- bark style: [POST|GET] /bark/:sourceId/:key?title=&body=
    mm = pathname.match(/^\/bark\/([a-zA-Z0-9_-]+)\/([^/]+)$/);
    if (mm) {
      const source = findSourceById(mm[1]);
      const k = mm[2];
      let raw = Buffer.alloc(0);
      if (m === 'POST' || m === 'PUT') raw = await readBody(req);
      const parsed = normalizeBody(raw);
      // bark clients send a device key; scripts may also send the source secret or sha256(secret).
      const hash = sha256(k);
      const barkOk = (source.key && safeEqual(k, source.key)) || (source.secret && safeEqual(k, source.secret)) || (source.secretHash && hash === source.secretHash) || (source.secret && hash === sha256(source.secret));
      if (!barkOk) webhookAuth(req, url, source, raw, parsed);
      const bark = adaptBark(Object.fromEntries(url.searchParams.entries()));
      const out = ingest({ source, body: bark.body, req, special: bark.special });
      return send(res, 200, { code: 200, message: 'success', timestamp: Date.now(), data: { ...out.result, msgId: out.msg?.id } });
    }

    // ---------- email (ekko-connect mail) ----------
    if ((pathname === '/hook/email' || pathname === '/hook/email/subscription') && m === 'POST') {
      const source = findSourceById('email');
      const raw = await readBody(req);
      const body = normalizeBody(raw);
      webhookAuth(req, url, source, raw, body);
      const notMail = !hasMailSignal(body);
      if (process.env.DEBUG_MAIL) console.log('[dbg-mail]', notMail, JSON.stringify(body).slice(0, 120));
      if (notMail) {
        // Payload that smells like a connector capability query, not mail: refuse quietly.
        return send(res, 200, { ok: true, ignored: true });
      }
      const out = ingest({ source, body, req });
      return send(res, 202, ingestReply(out));
    }

    // ---------- admin API
    // ---------- media upload: raw body + x-filename / ?name=, source secret or admin
    if ((pathname === '/api/upload' || pathname === '/api/admin/upload') && m === 'POST') {
      const tokenRaw = url.searchParams.get('token') || req.headers['x-pushhub-secret'] || req.headers['x-source-secret'] || bearer(req);
      const token = typeof tokenRaw === 'string' ? tokenRaw : '';
      const isAdmin = token && safeEqual(token, cfg.adminToken);
      const source = token ? store.data.sources.find((s) => safeEqual(token, s.secret || '') || safeEqual(token, s.key || '')) : null;
      if (!isAdmin && !source) throw new HttpError(401, 'upload requires an admin token or source secret');
      const filename = url.searchParams.get('name') || req.headers['x-filename'] || 'file';
      const raw = await readBody(req, maxUploadBytes());
      const attachment = saveUpload({ buffer: raw, filename, mime: req.headers['content-type'] || '' });
      recordActivity({ kind: 'upload', source: source ? source.id : 'admin', ip: clientIp(req), filename: attachment.name, ok: true });
      return send(res, 201, { ok: true, attachment });
    }

    // ---------- media: GET/HEAD serve, DELETE (admin) cleanup
    if (pathname.startsWith('/media/')) {
      if (m === 'DELETE') {
        if (!adminOk(req)) throw new HttpError(401, 'admin token required');
        if (!deleteMedia(pathname)) throw new HttpError(404, 'media not found');
        return send(res, 200, { ok: true });
      }
      if ((m === 'GET' || m === 'HEAD') && serveMedia(req, res, pathname)) return;
    }

    if (pathname.startsWith('/api/admin/')) {
      if (!adminOk(req)) throw new HttpError(401, 'admin token required');
      return await admin(req, res, pathname, url);
    }

    // ---------- legacy alias used by very small scripts
    if (pathname === '/push' && (m === 'POST' || m === 'PUT')) {
      const source = findSourceById(url.searchParams.get('source') || 'manual');
      const raw = await readBody(req);
      const body = normalizeBody(raw);
      webhookAuth(req, url, source, raw, body);
      const out = ingest({ source, body, req });
      return send(res, 202, ingestReply(out));
    }

    if (m === 'GET' || m === 'HEAD') {
      if (pathname.startsWith('/media/')) {
        if (serveMedia(req, res, pathname)) return;
        throw new HttpError(404, 'media not found');
      }
      if (serveStatic(req, res, pathname)) return;
    }
    throw new HttpError(404, 'not found');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : (Number.isInteger(e.status) && e.status >= 400 && e.status < 500 ? e.status : 500);
    if (status >= 500) console.error('[error]', req.method, pathname, e);
    if (!res.headersSent) send(res, status, { ok: false, error: e.message, ...(e.extra || {}) });
    else res.end();
  }
});

function hasMailSignal(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.action && !body.snippet && !body.subject) return false; // connector API call, not mail
  const fields = ['subject', 'snippet', 'from', 'to', 'date', 'permalink', 'body', 'text', 'preview'];
  const hasField = (o) => o && typeof o === 'object' && !Array.isArray(o) && fields.some((f) => o[f] !== undefined);
  if (Array.isArray(body.messages) || Array.isArray(body.emails)) return body.messages?.[0] !== undefined || body.emails?.[0] !== undefined;
  if (hasField(body)) return true;
  const d = body.data;
  if (Array.isArray(d)) return hasField(d[0]);
  if (d && typeof d === 'object') return hasField(d) || (Array.isArray(d.messages) && hasField(d.messages[0]));
  return false;
}

function messageSummary(m) {
  const body = m.body || '';
  return {
    id: m.id,
    ts: m.ts,
    source: m.source,
    title: m.title,
    body: body.length > 600 ? body.slice(0, 600) + '…' : body,
    bodyLen: body.length,
    devices: m.devices || [],
    receipts: m.receipts || {},
    url: m.url || '',
    image: m.image || '',
    attachments: m.attachments || [],
    priority: m.priority,
  };
}

async function admin(req, res, pathname, url) {
  const m = req.method;

  if (pathname === '/api/admin/overview' && m === 'GET') {
    // DEV_MODE is for local testing only: it exposes webhook secrets so scripts can self-test.
    const devSecrets = process.env.DEV_MODE === '1';
    return send(res, 200, {
      ok: true,
      serverUrl: baseUrl(req),
      wsPath: cfg.wsPath,
      uptime: Math.round((Date.now() - startedAt) / 1000),
      devices: store.data.devices.filter((d) => !d.revokedAt).map(deviceView),
      sources: store.data.sources.map((s) => ({ ...sourceView(s), webhookUrl: `${baseUrl(req)}/hook/${s.id}`, ...(devSecrets ? { secret: s.secret, key: s.key } : {}) })),
      messages: store.recentMessages(100).map(messageSummary),
      activity: activity.slice(0, 100),
      stats: {
        online: store.data.devices.filter((d) => !d.revokedAt && hub.isOnline(d.id)).length,
        messages24h: store.data.messages.filter((x) => Date.now() - Date.parse(x.ts) < 86400_000).length,
        totalMessages: store.data.messages.length,
      },
      settings: store.data.settings,
    });
  }

  // ---- devices
  if (pathname === '/api/admin/apk' && m === 'GET') {
    const mode = new URL(req.url, 'http://x').searchParams.get('mode') || 'local';
    if (!['local', 'public'].includes(mode)) throw new HttpError(400, 'mode 必须是 local 或 public');
    let metadata;
    try { ({ metadata } = readRelease(ROOT)); } catch { throw new HttpError(503, 'APK 发布信息缺失或校验失败，请重新发布'); }
    const publicUrl = store.data.settings.apkPublicDownloadUrl;
    if (mode === 'public' && !publicUrl) throw new HttpError(400, '尚未配置公网 APK 下载地址，请在设置中保存完整 APK URL');
    const first = key => String(req.headers[key] || '').split(',')[0].trim();
    const prefix = first('x-forwarded-prefix').replace(/\/+$/, '');
    if (prefix && (!prefix.startsWith('/') || /[?#\\\s]/.test(prefix))) throw new HttpError(400, '无效代理路径前缀');
    const base = pairUrl(`${first('x-forwarded-proto') || 'http'}://${first('x-forwarded-host') || req.headers.host}${prefix}`, '请求地址');
    const downloadUrl = mode === 'public' ? pairUrl(publicUrl, '公网 APK 下载地址') : `${base}/${metadata.storageFilename || metadata.filename}`;
    return send(res, 200, { ok: true, ...metadata, mode, publicConfigured: !!publicUrl, downloadUrl, qr: await QRCode.toDataURL(downloadUrl, { errorCorrectionLevel: 'M', margin: 4 }) });
  }

  if (pathname === '/api/admin/pair' && m === 'POST') {
    const body = await readJson(req);
    const mode = body.mode === undefined ? 'local' : body.mode;
    const serverUrl = pairingBase(req, mode);
    // 40 bits, Crockford-ish alphabet without look-alike chars (I/L/O/U).
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let code = '';
    for (let i = 0; i < 8; i++) code += alphabet[crypto.randomInt(alphabet.length)];
    const displayCode = `${code.slice(0, 4)}-${code.slice(4)}`;
    const pairing = { serverUrl, mode, id: rid(8), codeHash: sha256(code), createdAt: nowIso(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), usedAt: null };
    await store.mutate((d) => {
      d.pairings.push(pairing);
      if (d.pairings.length > 100) d.pairings.splice(0, d.pairings.length - 100);
    });
    // DEV_MODE also returns the raw code so local smoke tests / scripts can pair without a screen.
    const dev = process.env.DEV_MODE === '1' ? { devCode: code } : {};
    return send(res, 200, { ok: true, code: displayCode, expiresAt: pairing.expiresAt, serverUrl, mode, wsPath: cfg.wsPath, qr: await QRCode.toDataURL(JSON.stringify({ server: serverUrl, code: displayCode }), { errorCorrectionLevel: 'M', margin: 4 }), ...dev });
  }

  let mm = pathname.match(/^\/api\/admin\/devices\/([a-zA-Z0-9_-]+)$/);
  if (mm && (m === 'DELETE' || m === 'PATCH')) {
    const device = store.getDevice(mm[1]);
    if (!device) throw new HttpError(404, 'no such device');
    if (m === 'DELETE') {
      await store.mutate((d) => {
        d.devices = d.devices.filter((x) => x.id !== device.id);
      });
      return send(res, 200, { ok: true });
    }
    const body = await readJson(req);
    await store.mutate(() => {
      if (typeof body.name === 'string') device.name = oneLine(body.name, 60);
      if (typeof body.recipient === 'string') device.recipient = oneLine(body.recipient, 200);
    });
    return send(res, 200, { ok: true, device: deviceView(device) });
  }
  if (pathname === '/api/admin/devices' && m === 'GET') {
    return send(res, 200, { ok: true, devices: store.data.devices.map(deviceView) });
  }
  // re-show / rotate token of an existing device for troubleshooting
  mm = pathname.match(/^\/api\/admin\/devices\/([a-zA-Z0-9_-]+)\/token$/);
  if (mm && m === 'GET') {
    const device = store.getDevice(mm[1]);
    if (!device) throw new HttpError(404, 'no such device');
    return send(res, 200, { ok: true, token: device.token });
  }
  if (mm && m === 'POST') {
    const device = store.getDevice(mm[1]);
    if (!device) throw new HttpError(404, 'no such device');
    const token = crypto.randomBytes(24).toString('hex');
    await store.mutate(() => {
      device.token = token;
    });
    return send(res, 200, { ok: true, token });
  }

  // ---- sources
  if (pathname === '/api/admin/sources' && m === 'POST') {
    const b = await readJson(req);
    const id = oneLine(b.id || '', 40).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id) throw new HttpError(400, 'id required (a-z, 0-9, -, _)');
    if (store.getSource(id)) throw new HttpError(409, 'source already exists');
    const preset = b.preset === 'email' ? EMAIL_DEFAULTS : null;
    const source = {
      id,
      name: oneLine(b.name || id, 40),
      kind: oneLine(b.kind || 'webhook', 20),
      color: oneLine(b.color || '#5B8DEF', 20),
      enabled: b.enabled !== false,
      defaultPriority: ['high', 'normal', 'low'].includes(b.defaultPriority) ? b.defaultPriority : 'normal',
      fields: {},
      defaults: preset || null,
      scrubEmails: b.preset === 'email' ? true : !!b.scrubEmails,
      filterRecipient: !!b.filterRecipient,
      secret: crypto.randomBytes(16).toString('hex'),
      key: crypto.randomBytes(8).toString('hex'),
      createdAt: nowIso(),
      count: 0,
      lastAt: null,
    };
    await store.mutate((d) => d.sources.push(source));
    return send(res, 200, { ok: true, source: { ...sourceView(source), webhookUrl: `${baseUrl(req)}/hook/${source.id}`, secret: source.secret, key: source.key } });
  }
  // Reveal an integration secret on demand (admin token required, same as rotate).
  mm = pathname.match(/^\/api\/admin\/sources\/([a-zA-Z0-9_-]+)\/secret$/);
  if (mm && m === 'GET') {
    const source = store.getSource(mm[1]);
    if (!source) throw new HttpError(404, 'no such source');
    return send(res, 200, { ok: true, secret: source.secret, key: source.key });
  }
  mm = pathname.match(/^\/api\/admin\/sources\/([a-zA-Z0-9_-]+)(\/rotate)?$/);
  if (mm) {
    const source = store.getSource(mm[1]);
    if (!source) throw new HttpError(404, 'no such source');
    if (m === 'PATCH') {
      const b = await readJson(req);
      await store.mutate(() => {
        if (typeof b.name === 'string') source.name = oneLine(b.name, 40);
        if (typeof b.enabled === 'boolean') source.enabled = b.enabled;
        if (typeof b.color === 'string') source.color = oneLine(b.color, 20);
        if (['high', 'normal', 'low'].includes(b.defaultPriority)) source.defaultPriority = b.defaultPriority;
        if (b.fields && typeof b.fields === 'object') source.fields = sanitizeFields(b.fields);
        if (typeof b.scrubEmails === 'boolean') source.scrubEmails = b.scrubEmails;
      });
      return send(res, 200, { ok: true, source: { ...sourceView(source), webhookUrl: `${baseUrl(req)}/hook/${source.id}` } });
    }
    if (m === 'DELETE') {
      await store.mutate((d) => {
        d.sources = d.sources.filter((x) => x.id !== source.id);
      });
      return send(res, 200, { ok: true });
    }
    if (m === 'POST' && mm[2]) {
      const secret = crypto.randomBytes(16).toString('hex');
      await store.mutate(() => {
        source.secret = secret;
        source.secretHash = null;
      });
      return send(res, 200, { ok: true, secret });
    }
  }

  // ---- test push to a source (goes through the whole pipeline)
  mm = pathname.match(/^\/api\/admin\/sources\/([a-zA-Z0-9_-]+)\/test$/);
  if (mm && m === 'POST') {
    const source = store.getSource(mm[1]);
    if (!source) throw new HttpError(404, 'no such source');
    const out = ingest({ source, body: { title: `测试 · ${source.name}`, text: `来自「${source.name}」的测试消息 ${new Date().toLocaleTimeString('zh-CN')}`, __test: true }, req });
    return send(res, 202, ingestReply(out));
  }

  // ---- 接入诊断
  if (pathname === '/api/admin/activity' && m === 'GET') {
    return send(res, 200, { ok: true, activity });
  }
  if (pathname === '/api/admin/activity' && m === 'DELETE') {
    activity.length = 0;
    return send(res, 200, { ok: true });
  }

  // Manual composition uses canonical fields, independent of webhook templates.
  if (pathname === '/api/admin/messages' && m === 'POST') {
    const b = await readJson(req);
    if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'invalid message');
    const source = store.getSource(typeof b.source === 'string' ? b.source : 'manual');
    if (!source) throw new HttpError(404, 'no such source');
    if (typeof b.title !== 'string' || !b.title.trim() || b.title.length > 512) throw new HttpError(400, 'title required (max 512 characters)');
    if (typeof b.body !== 'string' || !b.body.trim() || b.body.length > 20000) throw new HttpError(400, 'body required (max 20000 characters)');
    if (b.url !== undefined && typeof b.url !== 'string') throw new HttpError(400, 'invalid link');
    const link = (b.url || '').trim();
    if (link) {
      try { if (!['http:', 'https:'].includes(new URL(link).protocol)) throw new Error(); }
      catch { throw new HttpError(400, 'link must be an HTTP or HTTPS URL'); }
      if (link.length > 2000) throw new HttpError(400, 'link too long');
    }
    if (b.priority !== undefined && !['high', 'normal', 'low'].includes(b.priority)) throw new HttpError(400, 'invalid priority');
    let devices;
    if (b.devices !== undefined) {
      if (!Array.isArray(b.devices) || !b.devices.length || b.devices.some((id) => typeof id !== 'string' || !store.data.devices.some((d) => d.id === id && !d.revokedAt))) throw new HttpError(400, 'select valid target devices');
      devices = [...new Set(b.devices)];
    }
    if (!(devices || store.data.devices.filter((d) => !d.revokedAt)).length) throw new HttpError(400, 'no paired devices');
    let attachments = [];
    if (b.attachments !== undefined) {
      if (!Array.isArray(b.attachments) || b.attachments.length > 10) throw new HttpError(400, 'attachments must be an array of at most 10 items');
      attachments = normalizeAttachments({ attachments: b.attachments });
      if (attachments.length !== b.attachments.length) throw new HttpError(400, 'invalid attachment (need an http(s) or /media/ URL)');
    }
    const out = ingest({ source: { ...source, fields: {}, defaults: null, scrubEmails: false, filterRecipient: false }, body: { title: b.title, body: b.body, url: link, image: b.image, attachments, priority: b.priority || source.defaultPriority }, req, special: { devices } });
    source.lastAt = out.msg.ts;
    source.count = (source.count || 0) + 1;
    store.saveSync();
    return send(res, 202, ingestReply(out));
  }

  // ---- messages
  if (pathname === '/api/admin/messages' && m === 'DELETE') {
    await store.mutate((d) => {
      d.messages = [];
    });
    return send(res, 200, { ok: true });
  }
  mm = pathname.match(/^\/api\/admin\/messages\/([a-zA-Z0-9_-]+)$/);
  if (mm && m === 'GET') {
    const msg = store.data.messages.find((x) => x.id === mm[1]);
    if (!msg) throw new HttpError(404, 'no such message');
    return send(res, 200, { ok: true, message: msg });
  }
  if (mm && m === 'DELETE') {
    await store.mutate((d) => {
      d.messages = d.messages.filter((x) => x.id !== mm[1]);
    });
    return send(res, 200, { ok: true });
  }
  if (pathname === '/api/admin/messages' && m === 'GET') {
    return send(res, 200, { ok: true, messages: store.recentMessages(Number(url.searchParams.get('limit')) || 200) });
  }
  mm = pathname.match(/^\/api\/admin\/messages\/([a-zA-Z0-9_-]+)\/replay$/);
  if (mm && m === 'POST') {
    const msg = store.data.messages.find((x) => x.id === mm[1]);
    if (!msg) throw new HttpError(404, 'no such message');
    const r = hub.deliver({ ...msg, id: rid(10), ts: nowIso(), replayOf: msg.id });
    return send(res, 200, { ok: true, ...r });
  }

  // ---- settings
  if (pathname === '/api/admin/settings' && m === 'PATCH') {
    const b = await readJson(req);
    const addresses = {};
    for (const key of ['publicPairUrl', 'localPairUrl', 'apkPublicDownloadUrl']) if (Object.hasOwn(b, key)) addresses[key] = pairUrl(b[key], key);
    await store.mutate((d) => {
      Object.assign(d.settings, addresses);
      if (Number.isFinite(b.retentionDays)) d.settings.retentionDays = Math.max(1, Math.min(90, b.retentionDays));
      if (Number.isFinite(b.maxMessages)) d.settings.maxMessages = Math.max(100, Math.min(50000, b.maxMessages));
    });
    return send(res, 200, { ok: true, settings: store.data.settings });
  }

  throw new HttpError(404, 'unknown admin route');
}

function sanitizeFields(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!['title', 'body', 'url', 'image', 'priority'].includes(k)) continue;
    if (typeof v === 'string' && v.length <= 200) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- boot
hub.attach(server, cfg.wsPath);
server.listen(cfg.port, cfg.host, () => {
  console.log(`[pushhub] listening on http://${cfg.host}:${cfg.port}  ws=${cfg.wsPath}  data=${cfg.dataFile}`);
});
const housekeeper = setInterval(() => {
  const n = store.prune();
  if (n) console.log(`[prune] removed ${n} messages`);
}, 3600_000);
housekeeper.unref?.();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    try {
      store.saveSync();
    } catch {}
    process.exit(0);
  });
}
