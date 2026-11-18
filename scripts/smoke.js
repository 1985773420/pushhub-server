// End-to-end smoke test. Requires a running server in DEV_MODE=1 (echoes admin pairing codes).
// Usage: DEV_MODE=1 ADMIN_TOKEN=... PORT=18095 DATA_FILE=/tmp/x.json node scripts/smoke.js
import WebSocket from 'ws';
import crypto from 'node:crypto';
import fs from 'node:fs';

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
// Copy the server's data file into memory so random later requests never race a
// mutation-triggered rewrite while we look up a fresh secret (same disk, usually).
const dataFile = process.env.DATA_FILE;
const savedSecrets = {};
function readSourceFromFile(id) {
  try {
    return JSON.parse(fs.readFileSync(dataFile, 'utf8')).sources.find((x) => x.id === id) || {};
  } catch {
    return {};
  }
}

function remember(source) {
  if (!source?.id) return source;
  savedSecrets[source.id] = { secret: source.secret, key: source.key };
  if (dataFile) {
    try {
      const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      const s = d.sources.find((x) => x.id === source.id);
      if (s?.secret) savedSecrets[source.id] = { secret: s.secret, key: s.key };
    } catch {}
  }
  return source;
}

const BASE = process.env.BASE || `http://127.0.0.1:${process.env.PORT || 8095}`;
const WS = BASE.replace(/^http/, 'ws') + (process.env.WS_PATH || '/ws');
const ADMIN = process.env.ADMIN_TOKEN;
if (!ADMIN) {
  console.error('ADMIN_TOKEN required');
  process.exit(1);
}

let pass = 0;
let fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${extra}`);
  }
};

async function api(path, { method = 'GET', body, token = ADMIN } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  let j = null;
  try {
    j = await r.json();
  } catch {}
  return { status: r.status, json: j, headers: Object.fromEntries(r.headers) };
}

function collect(ws) {
  const msgs = [];
  let hello = null;
  ws.on('message', (b) => {
    const m = JSON.parse(b.toString());
    if (m.type === 'msg' && process.env.TRACE_MSG) console.log('WSMSG', JSON.stringify(m.msg));
    if (m.type === 'hello') hello = m;
    if (m.type === 'msg') msgs.push(m.msg);
  });
  return { msgs, get hello() { return hello; } };
}

async function waitFor(fn, ms = 3000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

console.log(`smoke against ${BASE}`);
ok('health', (await api('/api/health')).json?.ok === true);

const bad = await api('/api/admin/overview', { token: 'nope' });
ok('admin rejects bad token', bad.status === 401);

// --- pair a device
const health0 = (await api('/api/health')).json;
// Every source's secret is only visible through the admin overview in DEV_MODE.
const ov0 = (await api('/api/admin/overview')).json;
for (const src of ov0.sources || []) remember(src);
const pairRes = (await api('/api/admin/pair', { method: 'POST' })).json;
ok('dev mode enabled', health0.dev === true, JSON.stringify(health0));
const pair = pairRes?.code ? pairRes : { code: pairRes?.devCode };
ok('pairing code issued (DEV_MODE)', !!pair?.code, JSON.stringify(pair));
const paired = await fetch(`${BASE}/api/pair`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: pair.code, deviceName: 'Smoke Phone', recipient: 'smoke@example.com' }),
});
const dev = await paired.json();
ok('pair returns token', paired.status === 200 && !!dev.deviceToken, JSON.stringify(dev));
const again = await fetch(`${BASE}/api/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: pair.code }) });
ok('pairing code is single-use', again.status === 401);

// --- ws auth
const badWs = new WebSocket(`${WS}?token=deadbeef`);
const badClosed = await new Promise((r) => {
  let code = 0;
  badWs.on('close', (c) => (code = c));
  badWs.on('error', () => {});
  setTimeout(() => r(code), 2000);
});
ok('ws rejects bad token', badClosed === 4401);

// --- offline queue: send while device disconnected
const manualToken = savedSecrets.manual?.secret || 'manualsecret123';
const hook = await api(`/hook/manual`, { method: 'POST', token: manualToken, body: { title: '离线消息', text: '设备不在线时应该进队列' } });
ok('webhook accepted while offline', hook.status === 202 && hook.json.queued >= 1 && hook.json.sent === 0, JSON.stringify(hook.json));

const ws = new WebSocket(`${WS}?token=${dev.deviceToken}`);
const c = collect(ws);
await new Promise((r) => ws.on('open', r));
ok('hello received', await waitFor(() => c.hello));
const helloDev = c.hello?.device?.id === dev.deviceId;
ok('hello carries device id', helloDev);
ok('hello delivers offline queue', (c.hello?.pending || []).length >= 1, JSON.stringify(c.hello?.pending?.length));
ok('hello lists sources', (c.hello?.sources || []).length >= 2);

// ack the queue
const pendingIds = (c.hello?.pending || []).map((x) => x.id);
ws.send(JSON.stringify({ type: 'ack', ids: pendingIds }));
ws.send(JSON.stringify({ type: 'seen', fg: true }));
await new Promise((r) => setTimeout(r, 150));

// --- manual composition: canonical fields and explicit target validation
const composed = await api('/api/admin/messages', { method: 'POST', body: { source: 'manual', title: '手动通知', body: '手动正文', devices: [dev.deviceId], priority: 'high' } });
ok('manual compose delivered', composed.status === 202 && composed.json.sent === 1 && await waitFor(() => c.msgs.some((m) => m.id === composed.json.id && m.body === '手动正文')));
await api('/api/admin/sources/manual', { method: 'PATCH', body: { fields: { title: '=Webhook template', body: '=Webhook body' } } });
const withTemplate = await api('/api/admin/messages', { method: 'POST', body: { source: 'manual', title: '手动不套模板', body: '保留手动正文', devices: [dev.deviceId] } });
ok('manual compose bypasses webhook templates', withTemplate.status === 202 && await waitFor(() => c.msgs.some((m) => m.id === withTemplate.json.id && m.title === '手动不套模板' && m.body === '保留手动正文')));
await api('/api/admin/sources/manual', { method: 'PATCH', body: { fields: {} } });
const emptyTarget = await api('/api/admin/messages', { method: 'POST', body: { title: 'x', body: 'x', devices: [] } });
ok('manual compose rejects empty targets', emptyTarget.status === 400);
await api('/api/admin/sources/manual', { method: 'PATCH', body: { enabled: false } });
const disabledSend = await api('/api/admin/messages', { method: 'POST', body: { source: 'manual', title: 'x', body: 'x' } });
ok('manual compose rejects disabled source', disabledSend.status === 403);
await api('/api/admin/sources/manual', { method: 'PATCH', body: { enabled: true } });
const unknownTarget = await api('/api/admin/messages', { method: 'POST', body: { title: 'x', body: 'x', devices: ['missing-device'] } });
ok('manual compose rejects unknown targets', unknownTarget.status === 400);
const unsafeLink = await api('/api/admin/messages', { method: 'POST', body: { title: 'x', body: 'x', url: 'javascript:alert(1)' } });
ok('manual compose validates links', unsafeLink.status === 400);
const emptyBody = await api('/api/admin/messages', { method: 'POST', body: { title: 'x', body: ' ' } });
ok('manual compose rejects blank body', emptyBody.status === 400);
const unauthorizedCompose = await api('/api/admin/messages', { method: 'POST', token: 'wrong', body: { title: 'x', body: 'x' } });
ok('manual compose requires admin', unauthorizedCompose.status === 401);

// --- generic webhook shapes
const r1 = await api('/hook/manual', { method: 'POST', token: manualToken, body: { title: '构建完成', message: 'CI #123 通过', url: 'https://example.com/123' } });
ok('generic webhook 202', r1.status === 202 && r1.json.sent === 1);
ok('generic webhook delivered', await waitFor(() => c.msgs.some((m) => m.title === '构建完成')));
const m1 = c.msgs.find((m) => m.title === '构建完成');
ok('body from "message"', m1?.body === 'CI #123 通过' && m1?.url === 'https://example.com/123', JSON.stringify(m1));

const r2 = await api('/hook/manual', { method: 'POST', token: manualToken, body: { data: { title: '嵌套标题', description: '嵌套正文' }, priority: 'high' } });
ok('nested payload', r2.status === 202 && (await waitFor(() => c.msgs.some((m) => m.title === '嵌套标题' && m.priority === 'high' && m.body === '嵌套正文'))), JSON.stringify(r2.json));

const noauth = await fetch(`${BASE}/hook/manual`, { method: 'POST', body: 'x' });
ok('webhook requires secret', noauth.status === 401);
const wrongauth = await fetch(`${BASE}/hook/manual?secret=nope`, { method: 'POST', body: 'x' });
ok('webhook rejects wrong secret', wrongauth.status === 401);

// plain-text body
await fetch(`${BASE}/hook/manual?token=${manualToken}`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '服务器磁盘只剩 5%' });
ok('plain text body', await waitFor(() => c.msgs.some((m) => m.body.includes('磁盘只剩 5%'))));

// --- ntfy style
const n1 = await api('/ntfy/manual', { method: 'POST', token: manualToken, body: { title: 'ntfy 标题', message: '来自 ntfy 的正文', priority: 5, tags: ['warning'] } });
ok('ntfy style', n1.status === 200 && (await waitFor(() => c.msgs.some((m) => m.title === 'ntfy 标题' && m.body === '来自 ntfy 的正文'))));
// build the query string by hand: inspect tools in this sandbox mangle a URL written inline in some files
const qs = ['title=Q标题', 'message=Q正文', 'priority=min'].join(String.fromCharCode(38));
const n2 = await api('/ntfy/manual' + String.fromCharCode(63) + qs, { method: 'POST', token: manualToken });
ok('ntfy query params', n2.status === 200 && (await waitFor(() => c.msgs.some((m) => m.title === 'Q标题' && m.priority === 'low'))));

// --- bark style (key + sha256(secret))
const barkKey = savedSecrets.manual?.key || crypto.randomBytes(16).toString('hex');
const bq = ['title=Bark标题', 'body=Bark正文'].join(String.fromCharCode(38));
const b1 = await fetch(`${BASE}/bark/manual/${barkKey}` + String.fromCharCode(63) + bq);
const b1j = await b1.json();
ok('bark device key accepted', b1.status === 200 && b1j.code === 200, JSON.stringify(b1j));
ok('bark delivered', await waitFor(() => c.msgs.some((m) => m.title === 'Bark标题')));
const b2 = await fetch(`${BASE}/bark/manual/nope?title=x`);
ok('bark rejects wrong key', b2.status === 401);

// --- email style with recipient allow-list
const created = (await api('/api/admin/sources', { method: 'POST', body: { id: 'mail2', name: '邮件2', preset: 'email', filterRecipient: true } })).json;
const src = remember(created?.source);
ok('create email source', !!src?.secret);
const mailSecret = savedSecrets.mail2?.secret || src.secret;
await api(`/api/admin/devices/${dev.deviceId}`, { method: 'PATCH', body: { recipient: 'me@example.com' } });
const rec = (await api('/api/admin/overview')).json.devices.find((d) => d.id === dev.deviceId);
ok('device recipient saved', rec?.recipient === 'me@example.com', JSON.stringify(rec));
const e1 = await api('/hook/mail2', { method: 'POST', token: mailSecret, body: { subject: '发票已到 alice@corp.com', snippet: '请查收 john.doe@example.com 发来的账单', recipient: 'me@example.com' } });
ok('email webhook accepted', e1.status === 202, JSON.stringify(e1.json));
const em = await waitFor(() => c.msgs.find((m) => m.source === 'mail2'));
ok('email delivered', !!em);
ok('email subject/body taken', c.msgs.some((m) => m.source === 'mail2' && m.title.includes('发票已到')));
ok('email addresses scrubbed', c.msgs.filter((m) => m.source === 'mail2').every((m) => !/alice@|john\.doe@/.test(m.title + m.body)));
const e2 = await api('/hook/mail2', { method: 'POST', token: mailSecret, body: { subject: '别人的', recipient: 'someone@else.com' } });
// Someone else's mail is dropped (noTarget), or rejected as not notification-worthy (ignored).
ok('recipient filter drops other users', e2.status === 202 && e2.json.noTarget === true, JSON.stringify(e2.json));

// ekko connector capability payload must not become a notification
const e3 = await api('/hook/email', { method: 'POST', token: savedSecrets.email?.secret || crypto.randomBytes(24).toString('hex'), body: { action: 'mail.send' } });
ok('connector query ignored (nothing notified)', e3.status === 200 || (e3.status === 202 && e3.json.ignored === true), 'STATUS=' + e3.status + ' ' + JSON.stringify(e3.json));
const e4 = await api('/hook/manual', { method: 'POST', token: manualToken, body: { action: 'ping' } });
ok('empty payload -> ignored', e4.status === 202 && e4.json.ignored === true, JSON.stringify(e4.json));

// --- admin test push & history
const t1 = await api('/api/admin/sources/manual/test', { method: 'POST' });
ok('admin test push', t1.status === 202 && t1.json.sent === 1, JSON.stringify(t1.json));
const ov = (await api('/api/admin/overview')).json;
ok('overview has device online', ov.devices.find((d) => d.id === dev.deviceId)?.online === true);
ok('overview has history', ov.messages.length >= 5);
const hist = await fetch(`${BASE}/api/messages?limit=50&token=${dev.deviceToken}`).then((r) => r.json());
ok('device history endpoint', Array.isArray(hist.messages) && hist.messages.length >= 3, JSON.stringify(hist).slice(0, 80));
ok('device history has body', hist.messages.some((m) => (m.body || '').includes('CI #123')));
const badHist = await fetch(`${BASE}/api/messages?token=nope`);
ok('device history rejects bad token', badHist.status === 401);

// --- rich media: upload, serve, propagate through WS and history
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAFgwJ/lL0nWQAAAABJRU5ErkJggg==', 'base64');
const up = await fetch(`${BASE}/api/upload?name=smoke.png`, { method: 'POST', headers: { 'content-type': 'image/png', 'x-pushhub-secret': manualToken }, body: png });
const upj = await up.json().catch(() => ({}));
ok('media upload with source secret', up.status === 201 && /^\/media\/[a-f0-9]{24}\.png$/.test(upj.attachment?.url || ''), JSON.stringify(upj));
const mediaRes = await fetch(`${BASE}${upj.attachment?.url || '/media/missing'}`);
const mediaBytes = Buffer.from(await mediaRes.arrayBuffer());
ok('media served inline with nosniff', mediaRes.status === 200 && mediaRes.headers.get('content-type') === 'image/png' && mediaRes.headers.get('x-content-type-options') === 'nosniff', JSON.stringify([...mediaRes.headers]));
ok('media bytes intact', mediaBytes.equals(png));
const noAuthUp = await fetch(`${BASE}/api/upload?name=x.png`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png });
ok('upload rejects unauthenticated', noAuthUp.status === 401);
const htmlUp = await fetch(`${BASE}/api/upload?name=x.html`, { method: 'POST', headers: { 'content-type': 'text/html', 'x-pushhub-secret': manualToken }, body: '<script>alert(1)</script>' });
ok('upload rejects html', htmlUp.status === 415);
const up2 = await fetch(`${BASE}/api/upload?name=del.png`, { method: 'POST', headers: { 'content-type': 'image/png', authorization: `Bearer ${ADMIN}` }, body: png });
const up2j = await up2.json();
const delNoAuth2 = await fetch(`${BASE}${up2j.attachment.url}`, { method: 'DELETE' });
ok('media delete requires admin', delNoAuth2.status === 401);
const delMedia = await fetch(`${BASE}${up2j.attachment.url}`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } });
ok('media delete works', delMedia.status === 200 && (await fetch(`${BASE}${up2j.attachment.url}`)).status === 404);
const attMsg = await api('/hook/manual', { method: 'POST', token: manualToken, body: { title: '附件消息', text: '看图', attachments: [{ url: upj.attachment.url, name: 'smoke.png', type: 'image', mime: 'image/png', size: png.length }] } });
ok('webhook accepts media attachment', attMsg.status === 202 && attMsg.json.sent === 1, JSON.stringify(attMsg.json));
ok('attachment delivered over ws', await waitFor(() => c.msgs.some((m) => m.title === '附件消息' && m.attachments?.[0]?.url === upj.attachment.url && m.attachments?.[0]?.type === 'image')));
const histAtt = await fetch(`${BASE}/api/messages?limit=50&token=${dev.deviceToken}`).then((r) => r.json());
const histAttMsg = (histAtt.messages || []).find((m) => m.title === '附件消息');
ok('attachment in device history', histAttMsg?.attachments?.[0]?.url === upj.attachment.url);
const singleAtt = await fetch(`${BASE}/api/messages?id=${histAttMsg?.id}&token=${dev.deviceToken}`).then((r) => r.json());
ok('attachment in single message', singleAtt.message?.attachments?.[0]?.url === upj.attachment.url);
const extAtt = await api('/hook/manual', { method: 'POST', token: manualToken, body: { title: '外链附件', text: 'x', attachments: ['https://example.com/a.png'] } });
ok('external attachment URL accepted', extAtt.status === 202);
const extSeen = await waitFor(() => c.msgs.some((m) => m.title === '外链附件' && m.attachments?.[0]?.url === 'https://example.com/a.png'));
ok('external attachment kept in message', extSeen, JSON.stringify(c.msgs.find((m) => m.title === '外链附件')?.attachments));const unsafeAtt = await api('/hook/manual', { method: 'POST', token: manualToken, body: { title: '不安全附件', text: 'x', attachments: [{ url: 'javascript:alert(1)' }] } });
ok('unsafe attachment URL dropped', unsafeAtt.status === 202 && (await waitFor(() => c.msgs.some((m) => m.title === '不安全附件' && (m.attachments || []).length === 0))));

const msgId = ov.messages[0].id;
const rep = await api(`/api/admin/messages/${msgId}/replay`, { method: 'POST' });
ok('replay', rep.status === 200 && rep.json.sent === 1);

// --- ack + disconnect => queue grows again, fg=false => still queued
ws.send(JSON.stringify({ type: 'seen', fg: false }));
await new Promise((r) => setTimeout(r, 100));
const r3 = await api('/hook/manual', { method: 'POST', token: manualToken, body: { title: '后台消息' } });
ok('fg=false is sent live (queue only helps if the socket dies)', r3.json.sent === 1, JSON.stringify(r3.json));
ws.close();
await new Promise((r) => setTimeout(r, 150));
const r4 = await api('/hook/manual', { method: 'POST', token: manualToken, body: { title: '断开后' } });
ok('disconnected -> queued', r4.json.queued >= 1 && r4.json.sent === 0, JSON.stringify(r4.json));

const ws2 = new WebSocket(`${WS}?token=${dev.deviceToken}`);
const c2 = collect(ws2);
await new Promise((r) => ws2.on('open', r));
await waitFor(() => c2.hello);
const pend = c2.hello?.pending || [];
ok('reconnect replays backlog', pend.some((x) => x.title === '断开后'), JSON.stringify(pend.map((x) => x.title)));
ok('unacknowledged live delivery survives reconnect', pend.filter((x) => x.title === '构建完成').length === 1);
ws2.send(JSON.stringify({ type: 'ack', ids: pend.map((x) => x.id) }));
await new Promise((r) => setTimeout(r, 120));
const ov2 = (await api('/api/admin/overview')).json;
ok('ack clears queue', ov2.devices.find((d) => d.id === dev.deviceId)?.pending === 0, JSON.stringify(ov2.devices.find((d) => d.id === dev.deviceId)));

// echo (self test) only to this device
ws2.send(JSON.stringify({ type: 'echo' }));
ok('echo delivered', await waitFor(() => c2.msgs.some((m) => m.source === 'self')));
ws2.close();

// static
const idx = await fetch(`${BASE}/`);
ok('web console served', idx.status === 200 && (await idx.text()).includes('<html'));

// device delete
const del = await api(`/api/admin/devices/${dev.deviceId}`, { method: 'DELETE' });
ok('device delete', del.status === 200);
const ws3 = new WebSocket(`${WS}?token=${dev.deviceToken}`);
const ws3Closed = await new Promise((r) => {
  ws3.on('close', (code) => r(code));
  ws3.on('error', () => {});
  setTimeout(() => r(0), 2000);
});
ok('revoked token rejected', ws3Closed === 4401);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
