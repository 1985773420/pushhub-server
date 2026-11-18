import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushhub-pairing-'));
const listener = net.createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`;
const token = 'isolated-pairing-test-admin';
let child;
async function api(route, body, method = body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}
async function start() {
  child = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'data.json'), ADMIN_TOKEN: token, PUBLIC_URL: 'https://webhooks.example.invalid/wrong' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) {
    try { if ((await api('/api/health')).status === 200) return; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  throw Error('server not ready');
}
async function stop() { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; child = null; }
const settings = body => api('/api/admin/settings', body, 'PATCH');
async function create(body, expected) {
  const p = await api('/api/admin/pair', body);
  assert.equal(p.status, 200); assert.equal(p.body.serverUrl, expected);
  assert.match(p.body.qr, /^data:image\/png;base64,/);
  return p.body;
}
async function consume(p) {
  const r = await api('/api/pair', { code: p.code });
  assert.equal(r.status, 200); assert.equal(r.body.serverUrl, p.serverUrl);
  assert.ok(r.body.deviceToken);
  assert.equal((await api('/api/pair', { code: p.code })).status, 401);
}
try {
  await start();
  assert.equal((await api('/api/admin/pair', { mode: 'public' })).status, 400);
  await consume(await create({}, base)); // legacy request ignores PUBLIC_URL
  for (const value of ['ftp://host', 'https://u:p@host', 'https://host/?x', 'https://host/#x', 'https://host/?', 'https://host/#', 'bad', 7, null, 'https://host\\bad']) {
    assert.equal((await settings({ publicPairUrl: value, retentionDays: 9 })).status, 400);
  }
  assert.equal((await api('/api/admin/overview')).body.settings.retentionDays, 7);
  const local = 'http://192.0.2.10:8095/nested';
  const pub = 'https://push.example.invalid:9443/gateway';
  assert.equal((await settings({ localPairUrl: local + '/', publicPairUrl: pub + '/' })).status, 200);
  const a = await create({ mode: 'local' }, local);
  const b = await create({ mode: 'public' }, pub);
  assert.notEqual(a.code, b.code);
  assert.equal((await api('/api/admin/pair', { mode: 'invalid' })).status, 400);
  await stop(); await start();
  const saved = (await api('/api/admin/overview')).body.settings;
  assert.equal(saved.localPairUrl, local); assert.equal(saved.publicPairUrl, pub);
  await settings({ localPairUrl: 'http://192.0.2.11:8095', publicPairUrl: '' });
  await consume(a); await consume(b); // bound URLs survive restart and settings changes
  assert.equal((await api('/api/admin/pair', { mode: 'public' })).status, 400);
  await settings({ localPairUrl: '' });
  await consume(await create({}, base));
  console.log('PAIRING CHECKS PASSED: validation, atomic rejection, persistence/restart, local/public URL binding, one-time use, PUBLIC_URL independence');
} finally { if (child) await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
