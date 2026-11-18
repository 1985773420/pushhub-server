import { flatten, getPath, oneLine, multiLine, render, scrubEmails } from './util.js';

/**
 * Turn an arbitrary webhook body into the canonical message shape that the app renders.
 * Every source can override the fields with a dot-path template ("data.title", "raw.0.subject").
 */

export function rawText(body) {
  if (body === null || body === undefined) return '';
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

function firstDefined(ctx, field, candidates, map) {
  candidates = candidates || map?.[field] || [];
  const list = candidates;
  for (const c of list) {
    if (!c) continue;
    let v;
    if (c.startsWith('<')) {
      // literal =...>
      v = c.slice(1);
    } else {
      // One-level keys first ("data.xxx" resolves inside ctx.data), deep keys on the raw body.
      // The split keeps every candidate a single path segment: see scripts/lookup-check.js.
      if (c.indexOf('.') < 0) v = getPath(ctx.data, c);
      else {
        const seg = c.split('.');
        v = seg.length > 2 && seg[0] === 'data' ? getPath(ctx.data, seg[2]) : undefined;
        if (v === undefined) {
          const top = seg[0];
          const rest = seg.slice(1).join('.');
          const head = getPath(ctx.data, top);
          v = head === undefined || head === null || typeof head !== 'object' ? undefined : getPath(head, rest);
        }
      }
    }
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

const DEFAULT_CANDIDATES = {
  title: ['title', 'subject', 'name', 'header', 'data.title', 'data.subject', 'data.name', 'data.header', 'message.title'],
  body: ['body', 'text', 'content', 'message', 'desc', 'description', 'data.body', 'data.text', 'data.content', 'data.message', 'data.desc', 'data.description', 'data.msg'],
  url: ['url', 'link', 'href', 'data.url', 'data.link', 'permalink', 'data.permalink'],
  image: ['image', 'icon', 'img', 'data.image', 'data.icon', 'data.img'],
};

const EMAIL_SOURCE = {
  title: ['subject', 'title', 'data.subject', 'data.title', 'data.messages.0.subject'],
  body: ['snippet', 'body', 'text', 'preview', 'data.snippet', 'data.body', 'data.messages.0.snippet'],
  url: ['permalink', 'url', 'link', 'data.permalink', 'data.url'],
};

// Template scope: the body itself, plus one level of nesting under "data"
// (catches alertmanager-style {data:{title, description}} and {data:{subject}}).
function flatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  const out = { ...body, ...flatten(body) };
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) out.data = { ...body.data, ...flatten(body.data) };
  return out;
}

function ctxDataTop(body, key) {
  return body && typeof body === 'object' ? body[key] : undefined;
}

function ctxFor(body, req) {
  return {
    // Flattened top-level keys ("data.title") plus the original object for real dot-paths.
    data: flatBody(body),
    raw: body,
    headers: req?.headers ?? {},
    strings: Array.isArray(body?.strings) ? body.strings : [],
    source: null,
  };
}

export function normalize(source, body, req, { recipient, priority: specialPriority } = {}) {
  const ctx = ctxFor(body, req);
  ctx.source = source;
  const map = { ...DEFAULT_CANDIDATES, ...(source.defaults || {}) };

  if (typeof source.recipientIndex === 'number' && Array.isArray(body?.strings)) {
    const v = body.strings[source.recipientIndex];
    if (v !== undefined) recipient = v;
  }

  const pick = (field) => {
    const tpl = source.fields?.[field];
    if (tpl) {
      if (tpl.startsWith('=')) return tpl.slice(1);
      if (tpl.startsWith('@')) return firstDefined(ctx, field, [tpl.slice(1)], map);
      return render(tpl, ctx);
    }
    return firstDefined(ctx, field, null, map);
  };

  const maxBody = Number(process.env.MAX_BODY_CHARS) > 0 ? Number(process.env.MAX_BODY_CHARS) : 20000;
  let title = oneLine(pick('title') ?? '', 512);
  let bodyText = multiLine(pick('body') ?? '', maxBody);
  const url = oneLine(pick('url') ?? '', 2000);
  const image = oneLine(pick('image') ?? '', 2000);
  const topPriority = ctxDataTop(body, 'priority');
  let priority = oneLine(topPriority ?? pick('priority') ?? source.defaultPriority ?? 'normal', 16);
  if (specialPriority) priority = specialPriority;

  if (!title && !bodyText) {
    const fallback = typeof body === 'string' ? body : '';
    bodyText = multiLine(fallback, maxBody);
  }
  if (!title && !bodyText) return null; // nothing notification-worthy (e.g. a service ping)

  if (source.scrubEmails || source.defaults === EMAIL_SOURCE) {
    title = scrubEmails(title);
    bodyText = scrubEmails(bodyText);
  }

  return {
    source: source.id,
    title: title || source.name,
    body: bodyText,
    url,
    image,
    attachments: normalizeAttachments(body),
    priority: ['high', 'normal', 'low'].includes(priority) ? priority : 'normal',
    recipient: recipient || '',
    tags: Array.isArray(body?.tags) ? body.tags.slice(0, 5).map(String) : [],
    raw: truncateRaw(body),
  };
}

// ---------------------------------------------------------------- attachments
// Canonical attachment: { id?, url, name, mime, type: image|video|file, size }
// Webhooks may send body.attachments = [{url,name,type,mime,size}], a single object,
// a bare URL string, or one of the common aliases. Only http(s) URLs and our own
// /media/ paths are accepted, so a message can never point the app at file:// or
// javascript: URLs.
const ATTACHMENT_LIMIT = 10;

function attachmentType(mime, name) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  const ext = String(name || '').split('.').pop().toLowerCase();
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic'].includes(ext)) return 'image';
  if (['mp4', 'webm', 'mov', 'm4v', 'mkv'].includes(ext)) return 'video';
  return 'file';
}

function filenameFromUrl(url) {
  try {
    const p = url.split('?')[0].split('#')[0];
    const last = p.split('/').pop();
    return last ? decodeURIComponent(last) : 'file';
  } catch {
    return 'file';
  }
}

export function normalizeAttachments(body) {
  if (!body || typeof body !== 'object') return [];
  let raw = body.attachments ?? body.attachment ?? body.media;
  if (raw === undefined && body.data && typeof body.data === 'object') {
    raw = body.data.attachments ?? body.data.attachment;
  }
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try { raw = JSON.parse(raw); } catch { /* keep as URL below */ }
  }
  const input = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const out = [];
  const seen = new Set();
  const add = (item) => {
    if (out.length >= ATTACHMENT_LIMIT) return;
    const o = typeof item === 'string' ? { url: item } : item;
    if (!o || typeof o !== 'object') return;
    const url = oneLine(o.url ?? o.src ?? o.href ?? '', 2000);
    if (!url) return;
    // 不用单个长正则做协议判断：沙箱里这个复合正则会误判 https 链接。
    const isHttp = url.startsWith('https://') || url.startsWith('http://');
    const isMedia = url.startsWith('/media/') && /^\/media\/[a-f0-9]{24}\.[a-z0-9]{1,8}$/.test(url);
    if (!isHttp && !isMedia) return;
    if (seen.has(url)) return;
    seen.add(url);
    const name = oneLine(o.name ?? o.filename ?? o.title ?? filenameFromUrl(url), 160) || 'file';
    const mime = oneLine(o.mime ?? o.contentType ?? o.content_type ?? '', 120);
    const type = ['image', 'video', 'file'].includes(o.type) ? o.type : attachmentType(mime, name);
    const size = Number(o.size) > 0 ? Math.min(Math.round(Number(o.size)), 2 ** 40) : 0;
    const id = oneLine(o.id ?? '', 40);
    out.push({ ...(id ? { id } : {}), url, name, mime, type, size });
  };
  for (const item of input) add(item);
  // Keep the historical single-image field useful to old clients.
  if (body.image) add({ url: body.image, type: 'image' });
  return out;
}

function truncateRaw(body) {
  const s = rawText(body);
  return s.length > 4000 ? `${s.slice(0, 4000)}…` : s;
}

/**
 * Input adapters. Each returns { body, special } where `special` may pin priority,
 * restrict target devices or reuse an upstream id.
 */
export function adaptNtfy(query, body) {
  const q = query || {};
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const pmap = { max: 'high', urgent: 'high', high: 'high', default: 'normal', low: 'low', min: 'low' };
  const text = b.message ?? b.msg ?? b.text ?? q.message ?? q.msg;
  const extra = { ...b };
  for (const k of ['title', 'message', 'msg', 'priority', 'tags']) delete extra[k];
  return {
    body: {
      ...extra,
      title: b.title ?? q.title,
      text,
      tags: b.tags ?? (q.tags ? String(q.tags).split(',') : undefined),
      url: b.url ?? b.click ?? q.click,
      image: b.image ?? b.attach ?? q.attach ?? q.icon,
    },
    special: {
      priority: q.priority ? pmap[q.priority] : b.priority ? pmap[b.priority] || 'normal' : undefined,
      devices: q.to ? [q.to] : undefined,
      id: q.id,
    },
  };
}

export function adaptBark(query) {
  const q = query || {};
  const body = q.body || q.title ? { title: q.title, text: q.body, url: q.url, image: q.image } : {};
  const lvl = q.level || (q.sound ? null : null);
  return {
    body,
    special: {
      priority: lvl === 'timeSensitive' || lvl === 'critical' ? 'high' : undefined,
      id: q.id,
    },
  };
}

export function normalizeBody(body) {
  if (Buffer.isBuffer(body)) body = body.toString('utf8').trim();
  if (typeof body !== 'string') return body;
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return { text: body };
  }
}

export const EMAIL_DEFAULTS = EMAIL_SOURCE;
