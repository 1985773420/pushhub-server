import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const cache = new Map();
const signature = s => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(':');
export function readRelease(root, requested) {
  // 挂载的 releases 目录里有本次发布时才用它；否则回退到 public/PushHub.apk + apk-release.json。
  // 不能只看环境变量：本地回归/旧部署里 APK_RELEASE_DIR 可能指向一个空目录。
  const preferred = process.env.APK_RELEASE_DIR;
  let dir = '';
  if (preferred) {
    try {
      const manifest = requested ? `${requested}.json` : 'active.json';
      if (fs.statSync(path.join(preferred, manifest)).isFile()) dir = preferred;
    } catch {}
  }
  if (!dir && requested) throw Error('APK release not found');
  const manifest = dir ? path.join(dir, requested ? `${requested}.json` : 'active.json') : path.join(root, 'public/apk-release.json');
  const metadata = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  if (metadata.schemaVersion !== 1 || metadata.packageName !== 'com.pushhub.app' || !/^[\w.-]+$/.test(metadata.versionName) || metadata.filename !== `PushHub-${metadata.versionName}.apk` || !Number.isSafeInteger(metadata.versionCode) || metadata.versionCode < 1 || !/^[a-f0-9]{64}$/.test(metadata.sha256)) throw Error('Invalid APK manifest');
  const identity = `PushHub-${metadata.versionName}-${metadata.sha256}.apk`;
  if (dir && (metadata.storageFilename !== identity || (requested && requested !== identity))) throw Error('Invalid APK identity');
  const file = dir ? path.join(dir, identity) : path.join(root, 'public/PushHub.apk');
  const fd = fs.openSync(file, 'r');
  try {
    const stat = fs.fstatSync(fd, { bigint: true });
    const key = signature(stat);
    let entry = cache.get(file);
    if (!entry || entry.key !== key) {
      const bytes = fs.readFileSync(fd);
      if (signature(fs.fstatSync(fd, { bigint: true })) !== key) throw Error('APK changed while reading');
      entry = { key, bytes, hash: crypto.createHash('sha256').update(bytes).digest('hex') };
      cache.clear(); cache.set(file, entry);
    }
    if (metadata.size !== entry.bytes.length || metadata.sha256 !== entry.hash) throw Error('APK checksum mismatch');
    return { metadata, bytes: entry.bytes };
  } finally { fs.closeSync(fd); }
}
