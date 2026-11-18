// Local regression runner: boots a throwaway server on an unused port (DEV_MODE),
// runs the lookup self-check and the live smoke test, then tears everything down.
// Usage: node scripts/run-check.js
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pushhub-check-'));
const dataFile = path.join(tmp, 'pushhub.json');
const adminToken = crypto.randomBytes(24).toString('hex');
const now = new Date().toISOString();
const devSecret = crypto.randomBytes(24).toString('hex');

const seed = {
  version: 1,
  sources: [
    { id: 'email', name: '邮箱', kind: 'email', color: '#E8735A', enabled: true, defaultPriority: 'normal', fields: {}, defaults: null, scrubEmails: true, secret: crypto.randomBytes(24).toString('hex'), key: crypto.randomBytes(16).toString('hex'), createdAt: now, count: 0 },
    { id: 'manual', name: '手动/脚本', kind: 'webhook', color: '#5B8DEF', enabled: true, defaultPriority: 'normal', fields: {}, defaults: null, secret: devSecret, key: crypto.randomBytes(16).toString('hex'), createdAt: now, count: 0 },
  ],
  devices: [],
  pending: [],
  pairings: [],
  messages: [],
  settings: { retentionDays: 7, maxMessages: 5000 },
};
fs.writeFileSync(dataFile, JSON.stringify(seed));

const freePort = () =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });

const port = await freePort();
const env = { ...process.env, PORT: String(port), DATA_FILE: dataFile, ADMIN_TOKEN: adminToken, DEV_MODE: '1', WS_PATH: '/ws' };
delete env.NODE_OPTIONS; // sandbox preloads are irrelevant here and can be slow

function run(cmd, args, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: 'inherit' });
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

async function healthy() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

let exitCode = 0;
if (process.env.TEST_APK === '1') {
  console.log('== APK download checks (optional fixtures required)');
  exitCode |= await run(process.execPath, ['scripts/apk-check.js']);
}
console.log('== pairing address / restart checks');
exitCode |= await run(process.execPath, ['scripts/pairing-check.js']);
console.log('== receipts checks');
exitCode |= await run(process.execPath, ['scripts/receipts-check.js']);
console.log('== webhook auth self-check');
exitCode |= await run(process.execPath, ['scripts/auth-check.js']);

console.log('\n== lookup/ingest self-check');
exitCode |= await run(process.execPath, ['scripts/lookup-check.js']);

console.log('\n== live smoke (server on port', port + ')');
const server = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverLog = '';
server.stdout.on('data', (d) => (serverLog += d));
server.stderr.on('data', (d) => (serverLog += d));

try {
  if (!(await healthy())) {
    console.error('server did not become healthy\n' + serverLog);
    exitCode = 1;
  } else {
    exitCode |= await run(process.execPath, ['scripts/smoke.js'], { DATA_FILE: dataFile });
  }
} finally {
  if (process.env.SHOW_SERVER_LOG === '1') console.log(serverLog);
  server.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(exitCode === 0 ? '\nALL CHECKS PASSED' : '\nCHECKS FAILED');
process.exit(exitCode ? 1 : 0);
