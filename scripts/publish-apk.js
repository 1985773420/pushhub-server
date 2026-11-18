import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv[2]) throw Error('Usage: node scripts/publish-apk.js /absolute/path/PushHub.apk');
const dir = path.resolve(process.env.APK_RELEASE_DIR || path.join(root, 'releases'));
fs.mkdirSync(dir, { recursive: true });
const stage = fs.mkdtempSync(path.join(dir, '.publish-'));
try {
  const apk = fs.readFileSync(path.resolve(process.argv[2]));
  const staged = path.join(stage, 'package.apk');
  fs.writeFileSync(staged, apk);
  const badging = execFileSync(process.env.AAPT2 || 'aapt2', ['dump', 'badging', staged], { encoding: 'utf8' });
  const match = badging.match(/^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'/m);
  if (!match || match[1] !== 'com.pushhub.app' || !/^[\w.-]+$/.test(match[3]) || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) < 1) throw Error('Invalid PushHub APK badging');
  const sha256 = crypto.createHash('sha256').update(apk).digest('hex');
  const metadata = { schemaVersion: 1, packageName: match[1], versionCode: Number(match[2]), versionName: match[3], filename: `PushHub-${match[3]}.apk`, storageFilename: `PushHub-${match[3]}-${sha256}.apk`, size: apk.length, sha256 };
  const target = path.join(dir, metadata.storageFilename);
  try { fs.linkSync(staged, target); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    if (!fs.readFileSync(target).equals(apk)) throw Error('Immutable release was modified');
  }
  const json = JSON.stringify(metadata, null, 2) + '\n';
  const immutableManifest = target + '.json';
  try { fs.writeFileSync(immutableManifest, json, { flag: 'wx' }); } catch (e) {
    if (e.code !== 'EEXIST' || fs.readFileSync(immutableManifest, 'utf8') !== json) throw Error('Immutable manifest conflict');
  }
  const active = path.join(stage, 'active.json');
  fs.writeFileSync(active, json);
  fs.renameSync(active, path.join(dir, 'active.json'));
  console.log(JSON.stringify(metadata, null, 2));
} finally { fs.rmSync(stage, { recursive: true, force: true }); }
