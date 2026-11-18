// 富媒体附件：上传、存储、托管。
// 设计：上传后返回 /media/<id>.<ext> 的相对 URL；消息里只存元数据，客户端按自己的
// 服务端地址拼接。媒体 ID 是 24 位随机 hex，不可枚举；不额外要求设备 token。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { oneLine } from './util.js';

const MIME_BY_EXT = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.heic': 'image/heic',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.mkv': 'video/x-matroska',
  '.pdf': 'application/pdf', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8', '.json': 'application/json',
  '.zip': 'application/zip', '.7z': 'application/x-7z-compressed', '.rar': 'application/vnd.rar',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const TYPE_BY_EXT = {
  image: new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.heic']),
  video: new Set(['.mp4', '.webm', '.mov', '.m4v', '.mkv']),
};

let dir = '';

export function initMedia(mediaDir) {
  dir = mediaDir;
  fs.mkdirSync(dir, { recursive: true });
}

export function maxUploadBytes() {
  const mb = Number(process.env.MAX_UPLOAD_MB);
  return (Number.isFinite(mb) && mb > 0 ? Math.min(mb, 200) : 20) * 1024 * 1024;
}

export function sanitizeName(name) {
  let s = oneLine(name || 'file', 160).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  if (!s || s === '.' || s === '..') s = 'file';
  return s;
}

export function guessType(mime, name) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  const ext = path.extname(String(name || '')).toLowerCase();
  if (TYPE_BY_EXT.image.has(ext)) return 'image';
  if (TYPE_BY_EXT.video.has(ext)) return 'video';
  return 'file';
}

function extFromMime(mime) {
  const base = String(mime || '').split(';')[0].trim().toLowerCase();
  for (const [ext, value] of Object.entries(MIME_BY_EXT)) {
    if (value.split(';')[0].trim().toLowerCase() === base) return ext;
  }
  return '';
}

export function saveUpload({ buffer, filename, mime }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw Object.assign(new Error('empty upload'), { status: 400 });
  }
  const limit = maxUploadBytes();
  if (buffer.length > limit) {
    throw Object.assign(new Error(`file too large (max ${Math.round(limit / 1024 / 1024)} MB)`), { status: 413 });
  }
  const name = sanitizeName(filename);
  let ext = path.extname(name).toLowerCase();
  const provided = String(mime || '').split(';')[0].trim().toLowerCase();
  // 不接受可执行的网页内容，避免在控制台同源里被内联渲染。
  if (['.html', '.htm', '.svg', '.js', '.mjs', '.xhtml'].includes(ext) || provided === 'text/html' || provided === 'image/svg+xml') {
    throw Object.assign(new Error('unsupported file type'), { status: 415 });
  }
  if (!ext || !MIME_BY_EXT[ext]) ext = extFromMime(provided) || '.bin';
  const id = crypto.randomBytes(12).toString('hex');
  const stored = id + ext;
  const file = path.join(dir, stored);
  fs.writeFileSync(file, buffer);
  const type = guessType(provided || MIME_BY_EXT[ext], name || stored);
  const meta = {
    id,
    url: `/media/${stored}`,
    name,
    mime: provided || MIME_BY_EXT[ext] || 'application/octet-stream',
    size: buffer.length,
    type,
  };
  try {
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(meta));
  } catch (e) {
    try { fs.unlinkSync(file); } catch {}
    throw e;
  }
  return meta;
}

export function readMediaMeta(stored) {
  const id = stored.split('.')[0];
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

/** 删除一个已上传的附件（文件 + 元数据）。只接受 /media/<id>.<ext>。 */
export function deleteMedia(url) {
  const m = String(url || '').match(/^\/media\/([a-f0-9]{24})(\.[a-z0-9]{1,8})$/i);
  if (!m) return false;
  const id = m[1];
  let removed = false;
  for (const f of [id + m[2].toLowerCase(), `${id}.json`]) {
    try {
      fs.unlinkSync(path.join(dir, f));
      removed = true;
    } catch {}
  }
  return removed;
}

/** @returns {boolean} true when the request was handled. */
export function serveMedia(req, res, pathname) {
  const m = pathname.match(/^\/media\/([a-f0-9]{24})(\.[a-z0-9]{1,8})$/i);
  if (!m) return false;
  const stored = m[1] + m[2].toLowerCase();
  const file = path.join(dir, stored);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const meta = readMediaMeta(stored) || {};
  const ext = path.extname(stored).toLowerCase();
  const mime = meta.mime || MIME_BY_EXT[ext] || 'application/octet-stream';
  const inline = (meta.type === 'image' || meta.type === 'video' || mime === 'application/pdf' || mime.startsWith('text/'))
    && ext !== '.svg' && ext !== '.html';
  const downloadName = sanitizeName(meta.name || stored);
  // Header values must be Latin-1; keep an ASCII fallback and add RFC 5987 for CJK names.
  const asciiName = downloadName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const headers = {
    'content-type': mime,
    'content-length': stat.size,
    'cache-control': 'public, max-age=86400',
    'x-content-type-options': 'nosniff',
    'content-disposition': `${inline ? 'inline' : 'attachment'}; filename="${asciiName}"; filename*=UTF-8''${encodeURIComponent(downloadName)}`,
  };
  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}