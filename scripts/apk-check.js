import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import vm from 'node:vm';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readRelease } from '../src/apk.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pushhub-apk-'));
const listener = net.createServer();
await new Promise(r => listener.listen(0, '127.0.0.1', r));
const port = listener.address().port;
await new Promise(r => listener.close(r));
const base = `http://127.0.0.1:${port}`, token = 'isolated-apk-admin-token';
let child;
async function api(route, body, headers = {}) {
 const r = await fetch(base + route, { method: body === undefined ? 'GET' : 'PATCH', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
 return { status: r.status, body: await r.json() };
}
async function start() {
 child = spawn(process.execPath, ['src/index.js'], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_FILE: path.join(dir, 'data.json'), ADMIN_TOKEN: token, PUBLIC_URL: 'https://wrong.invalid/webhooks' }, stdio: 'ignore' });
 for (let i = 0; i < 100; i++) { try { if ((await api('/api/health')).status === 200) return; } catch {} await new Promise(r => setTimeout(r, 50)); }
 throw Error('server not ready');
}
async function stop() { const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit; child = null; }
try {
 await start();
 assert.equal((await fetch(base + '/api/admin/apk')).status, 401);
 assert.equal((await api('/api/admin/apk?mode=public')).status, 400);
 assert.equal((await api('/api/admin/apk?mode=bad')).status, 400);
 for (const value of ['ftp://x/a.apk', 'https://a:b@x/a.apk', 'https://x/a.apk?q=1', 'https://x/a.apk#x', 17]) assert.equal((await api('/api/admin/settings', { apkPublicDownloadUrl: value, retentionDays: 22 })).status, 400);
 assert.equal((await api('/api/admin/overview')).body.settings.retentionDays, 7);
 const local = (await api('/api/admin/apk')).body;
 assert.equal(local.downloadUrl, base + '/PushHub-1.8.0.apk');
 assert.equal(local.versionName, '1.8.0'); assert.equal(local.versionCode, 11);
 assert.equal(local.sha256, '493b3b19b880e0683c617a3cbcac5ced6981cef587c910ffb5a48fae7fe6ed3d');
 assert.match(local.qr, /^data:image\/png;base64,/);
 assert.equal((await api('/api/admin/apk', undefined, { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'example.invalid', 'x-forwarded-prefix': '/push' })).body.downloadUrl, 'https://example.invalid/push/PushHub-1.8.0.apk');
 const pub = 'https://downloads.invalid/apps/PushHub-1.8.0.apk';
 assert.equal((await api('/api/admin/settings', { apkPublicDownloadUrl: pub, publicPairUrl: 'https://pair.invalid' })).status, 200);
 await stop(); await start();
 assert.equal((await api('/api/admin/apk?mode=public')).body.downloadUrl, pub);
 for (const route of ['/PushHub.apk', '/PushHub-1.8.0.apk']) {
  const r = await fetch(base + route), bytes = Buffer.from(await r.arrayBuffer());
  assert.equal(r.status, 200); assert.equal(bytes.length, local.size);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), local.sha256);
  assert.equal(r.headers.get('content-disposition'), 'attachment; filename="PushHub-1.8.0.apk"');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('etag'), `"${local.sha256}"`);
  assert.equal((await fetch(base + route, { method: 'HEAD' })).headers.get('content-length'), String(local.size));
 }
 await api('/api/admin/settings', { apkPublicDownloadUrl: '' });
 assert.equal((await api('/api/admin/apk?mode=public')).status, 400);
 const fixture = path.join(dir, 'fixture'); fs.mkdirSync(path.join(fixture, 'public'), { recursive: true });
 assert.throws(() => readRelease(fixture));
 const { metadata, bytes } = readRelease(root);
 fs.writeFileSync(path.join(fixture, 'public/PushHub.apk'), bytes);
 fs.writeFileSync(path.join(fixture, 'public/apk-release.json'), JSON.stringify({ ...metadata, sha256: 'stale' }));
 assert.throws(() => readRelease(fixture));
 await stop();
 const releases = path.join(dir, 'releases'); fs.mkdirSync(releases);
 process.env.APK_RELEASE_DIR = releases;
 function activate(versionName, payload) {
  const sha256 = crypto.createHash('sha256').update(payload).digest('hex');
  const m = { ...metadata, versionName, filename: `PushHub-${versionName}.apk`, sha256, size: payload.length, storageFilename: `PushHub-${versionName}-${sha256}.apk` };
  fs.writeFileSync(path.join(releases, m.storageFilename), payload);
  fs.writeFileSync(path.join(releases, m.storageFilename + '.json'), JSON.stringify(m));
  fs.writeFileSync(path.join(releases, 'next.json'), JSON.stringify(m)); fs.renameSync(path.join(releases, 'next.json'), path.join(releases, 'active.json'));
  return m;
 }
 activate('1.7.1', Buffer.from('first fixture')); await start();
 const old = (await api('/api/admin/apk')).body;
 for (const [version, payload] of [['1.8.0', 'second'], ['1.8.0', 'same-name changed bytes']]) {
  const m = activate(version, Buffer.from(payload));
  const active = (await api('/api/admin/apk')).body;
  assert.equal(active.sha256, m.sha256); assert.equal(active.filename, m.filename);
  for (const url of [active.downloadUrl, base + '/PushHub.apk', base + '/' + m.filename]) {
   const r = await fetch(url); assert.equal(r.status, 200); assert.equal(crypto.createHash('sha256').update(Buffer.from(await r.arrayBuffer())).digest('hex'), m.sha256);
  }
  const previous = await fetch(old.downloadUrl); assert.equal(previous.status, 200); assert.equal(await previous.text(), 'first fixture');
 }
 assert.equal((await fetch(base + '/PushHub-1.7.1.apk')).status, 404);
 const activeBefore = fs.readFileSync(path.join(releases, 'active.json'), 'utf8');
 const invalid = path.join(dir, 'bad.apk'); fs.writeFileSync(invalid, 'invalid');
 assert.throws(() => execFileSync(process.execPath, ['scripts/publish-apk.js', invalid], { cwd: root, env: { ...process.env, AAPT2: '/bin/false' }, stdio: 'pipe' }));
 assert.equal(fs.readFileSync(path.join(releases, 'active.json'), 'utf8'), activeBefore);
 const current = JSON.parse(activeBefore); fs.writeFileSync(path.join(releases, current.storageFilename), 'corrupt');
 assert.equal((await api('/api/admin/apk')).status, 503); assert.equal((await fetch(base + '/PushHub.apk')).status, 503);
 fs.unlinkSync(path.join(releases, current.storageFilename)); assert.equal((await api('/api/admin/apk')).status, 503);
 const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
 for (const script of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
 console.log('HOT RELEASE PASSED: live atomic switches, same-version different bytes, immutable old URLs, retired version 404, failed publish preservation, corrupt/missing 503, modal syntax');
 console.log('APK CHECKS PASSED: auth, validation, atomic rejection, persistence/restart, independent public/local URLs, proxy prefix, metadata hash/version, aliases, headers, stale/missing metadata');
} finally { if (child) await stop(); fs.rmSync(dir, { recursive: true, force: true }); }
