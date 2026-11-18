import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushhub-receipts-'));
const listener = net.createServer(); await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port; await new Promise(r => listener.close(r));
const token = 'isolated-test-admin-token'; const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'data.json'), ADMIN_TOKEN: token, PUBLIC_URL: base }, stdio: 'ignore' });
async function api(url, body, auth = token, method = body ? 'POST' : 'GET') {
 const r = await fetch(base + url, { method, headers: { Authorization: `Bearer ${auth}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
 return { status: r.status, body: await r.json() };
}
try {
 for (let i = 0; i < 100; i++) { try { if ((await api('/api/health')).status === 200) break; } catch {} await new Promise(r => setTimeout(r, 50)); }
 async function pair() { const p = (await api('/api/admin/pair', {})).body; assert.match(p.qr, /^data:image\/png;base64,/); const d = await api('/api/pair', { code: p.code }); assert.equal(d.status, 200); assert.equal((await api('/api/pair', { code: p.code })).status, 401); return d.body; }
 const a = await pair(), b = await pair();
 const id = (await api('/api/admin/messages', { title: 'receipt test', body: 'isolated', devices: [a.deviceId] })).body.id;
 assert.equal((await api('/api/receipts', { id, status: 'received' }, 'invalid')).status, 401);
 assert.equal((await api('/api/receipts', { id, status: 'confirmed' }, b.deviceToken)).status, 404);
 assert.equal((await api('/api/messages?token=' + b.deviceToken + '&id=' + id)).status, 404);
 assert.equal((await api('/api/receipts', { id, status: 'confirmed' }, a.deviceToken)).status, 200);
 const first = (await api('/api/admin/messages/' + id)).body.message.receipts[a.deviceId];
 assert.ok(first.received && first.opened && first.confirmed);
 await api('/api/receipts', { id, status: 'received' }, a.deviceToken);
 assert.deepEqual((await api('/api/admin/messages/' + id)).body.message.receipts[a.deviceId], first);
 await api('/api/admin/messages/' + id + '/replay', {});
 const replay = (await api('/api/admin/messages')).body.messages.find(m => m.replayOf === id);
 assert.ok(replay); assert.deepEqual(replay.devices, [a.deviceId]); assert.deepEqual(replay.receipts, {});
 const ws = new WebSocket(base.replace('http:', 'ws:') + '/ws?token=' + a.deviceToken);
 await new Promise((resolve, reject) => { ws.on('error', reject); ws.on('message', data => { const m = JSON.parse(data); if (m.type === 'hello') { assert.ok(m.pending.some(p => p.id === replay.id)); ws.send(JSON.stringify({ type: 'ack', id: replay.id })); resolve(); } }); });
 await new Promise(r => setTimeout(r, 100)); ws.close();
 assert.ok((await api('/api/admin/messages/' + replay.id)).body.message.receipts[a.deviceId].received);
 console.log('PASS receipt auth, cross-device isolation, monotonic ordering, replay persistence, WS ack and single-use pairing');
} finally { child.kill('SIGKILL'); await new Promise(r => child.once('exit', r)); fs.rmSync(dir, { recursive: true, force: true }); }
