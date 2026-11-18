// PushHub persistent store: JSON file with atomic writes and serialized mutations.
import fs from 'node:fs';
import path from 'node:path';

const nowIso = () => new Date().toISOString();

function normalize(d) {
  d ||= {};
  d.version ??= 1;
  d.sources ||= [];
  d.devices ||= [];
  d.pending ||= [];
  d.pairings ||= [];
  d.messages ||= [];
  d.settings ||= {};
  d.settings.retentionDays ??= 7;
  d.settings.maxMessages ??= 5000;
  d.settings.publicPairUrl ??= '';
  d.settings.localPairUrl ??= '';
  d.settings.apkPublicDownloadUrl ??= '';
  return d;
}

export class Store {
  constructor(file) {
    this.file = file;
    this.data = null;
    this._chain = Promise.resolve();
    this.load();
  }

  load() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    let raw = null;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (raw && raw.trim()) {
      try {
        this.data = normalize(JSON.parse(raw));
      } catch (e) {
        const bak = `${this.file}.corrupt-${Date.now()}`;
        fs.copyFileSync(this.file, bak);
        console.error(`[store] data file unreadable, backed up to ${bak}:`, e.message);
        this.data = null;
      }
    }
    if (!this.data) this.data = normalize({ version: 1 });
    this.saveSync();
  }

  _write() {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  saveSync() {
    this._write();
  }

  // All mutations go through here so concurrent webhooks never interleave.
  mutate(fn) {
    const run = () => {
      const r = fn(this.data);
      this._write();
      return r;
    };
    const p = this._chain.then(run, run);
    this._chain = p.catch(() => {});
    return p;
  }

  // ---- sources ----
  getSource(id) {
    return this.data.sources.find((s) => s.id === id) || null;
  }

  listSources() {
    return this.data.sources;
  }

  // ---- devices ----
  getDevice(id) {
    return this.data.devices.find((d) => d.id === id) || null;
  }

  // ---- messages ----
  recentMessages(limit = 200) {
    return this.data.messages.slice(0, limit);
  }

  pushMessage(msg) {
    const list = this.data.messages;
    list.unshift(msg);
    const { maxMessages } = this.data.settings;
    if (list.length > maxMessages) list.length = maxMessages;
    const cutoff = Date.now() - this.data.settings.retentionDays * 86400_000;
    while (list.length && Date.parse(list[list.length - 1].ts) < cutoff) list.pop();
  }

  receipt(device, id, status) {
    if (!['received', 'opened', 'confirmed'].includes(status)) return false;
    const msg = this.data.messages.find(m => m.id === id && m.devices?.includes(device.id));
    if (!msg) return false;
    msg.receipts ||= {};
    const r = msg.receipts[device.id] ||= {};
    // Higher states imply earlier transport/detail states; first server time wins.
    const states = ['received', 'opened', 'confirmed'];
    for (const state of states.slice(0, states.indexOf(status) + 1)) r[state] ||= nowIso();
    device.pending = (device.pending || []).filter(m => m.id !== id);
    this.saveSync();
    return true;
  }

  prune() {
    const cutoff = Date.now() - this.data.settings.retentionDays * 86400_000;
    const before = this.data.messages.length;
    this.data.messages = this.data.messages.filter((m) => Date.parse(m.ts) >= cutoff);
    this.data.pairings = this.data.pairings.filter(
      (p) => !p.usedAt && Date.parse(p.expiresAt) > Date.now()
    );
    return before - this.data.messages.length;
  }
}

export { nowIso };
