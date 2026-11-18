// WebSocket hub: one socket per device, keeps a per-device offline queue and routes messages.
import { WebSocketServer, WebSocket } from 'ws';
import { nowIso, rid } from './util.js';

const MAX_PENDING_PER_DEVICE = 200;

export class Hub {
  constructor({ store, onReplace }) {
    this.store = store;
    this.onReplace = onReplace || (() => {});
    this.wss = null;
    this.sockets = new Map(); // deviceId -> ws
  }

  attach(httpServer, path = '/ws') {
    this.wss = new WebSocketServer({ server: httpServer, path, maxPayload: 256 * 1024 });
    this.wss.on('connection', (ws, req) => this._onConnection(ws, req));
    const ping = setInterval(() => {
      for (const ws of this.wss.clients) {
        if (ws.isAlive === false) {
          ws.terminate();
          continue;
        }
        ws.isAlive = false;
        try {
          ws.ping();
        } catch {}
      }
    }, 30_000);
    ping.unref?.();
    this.wss.on('close', () => clearInterval(ping));
  }

  _onConnection(ws, req) {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });

    const url = new URL(req.url, 'http://localhost');
    const token = url.searchParams.get('token') || '';
    const device = token ? this.store.data.devices.find((d) => d.token === token && !d.revokedAt) : null;
    if (!device) {
      ws.send(JSON.stringify({ type: 'error', error: 'unauthorized' }));
      ws.close(4401, 'unauthorized');
      return;
    }

    // One live socket per device: a reconnecting app kicks the stale one.
    const existing = this.sockets.get(device.id);
    if (existing && existing.readyState === WebSocket.OPEN) {
      existing.send(JSON.stringify({ type: 'replaced' }));
      try {
        existing.close(4001, 'replaced');
      } catch {}
    }
    this.sockets.set(device.id, ws);
    ws.deviceId = device.id;

    device.lastSeenAt = nowIso();
    this.store.saveSync();
    device.lastIp = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');

    ws.send(
      JSON.stringify({
        type: 'hello',
        server: 'pushhub',
        time: nowIso(),
        device: { id: device.id, name: device.name },
        sources: this.store.data.sources.map(publicSource),
        pending: device.pending || [],
      })
    );

    ws.on('message', (buf) => {
      let m;
      try {
        m = JSON.parse(buf.toString('utf8'));
      } catch {
        return;
      }
      if (!m || typeof m.type !== 'string') return;
      if (this.store.getDevice(device.id) !== device || device.revokedAt || device.token !== token) { ws.close(4401, 'unauthorized'); return; }
      switch (m.type) {
        case 'ack': {
          const ids = new Set((Array.isArray(m.ids) ? m.ids : [m.id]).slice(0, 200));
          for (const id of ids) this.store.receipt(device, id, 'received');
          device.pending = (device.pending || []).filter((x) => !ids.has(x.id));
          this.store.saveSync();
          break;
        }
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', time: nowIso() }));
          break;
        case 'seen':
          device.fg = !!m.fg;
          break;
        case 'echo':
          // Lets the user verify the connection from the app without waiting for a real source.
          this.deliver({
            id: rid(6),
            ts: nowIso(),
            source: 'self',
            title: 'PushHub 自检',
            body: '这条消息只发给了当前设备，说明推送链路是通的。',
            priority: 'normal',
            devices: [device.id],
            test: true,
          });
          break;
        default:
          break;
      }
    });

    ws.on('close', () => {
      if (this.sockets.get(device.id) === ws) this.sockets.delete(device.id);
      device.lastOfflineAt = nowIso();
      this.store.saveSync();
    });
    ws.on('error', () => { device.lastErrorAt = nowIso(); device.lastError = 'WebSocket transport error'; this.store.saveSync(); });
  }

  /**
   * @param msg canonical message: {id, ts, source, title, body, url, image, priority, devices?, test?}
   * @returns {{sent:number, queued:number, offline:number}}
   */
  deliver(msg) {
    const targets = msg.devices && msg.devices.length ? msg.devices : this.store.data.devices.filter((d) => !d.revokedAt).map((d) => d.id);
    msg = { ...msg, devices: [...new Set(targets)].filter(id => { const d = this.store.getDevice(id); return d && !d.revokedAt; }), receipts: {} };
    this.store.pushMessage(msg);
    let sent = 0;
    let queued = 0;
    for (const id of targets) {
      const device = this.store.getDevice(id);
      if (!device || device.revokedAt) continue;
      const ws = this.sockets.get(id);
      const frame = JSON.stringify({ type: 'msg', msg });
      let ok = false;
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(frame);
          ok = true;
          sent++;
        } catch {}
      }
      { // Keep every delivery until the device acknowledges durable receipt.
        // A socket open in the foreground is the signal that the phone is being used.
        // Everything else (screen locked, app process dead, doze) goes to the offline
        // queue so the app's foreground-service reconnect can raise a notification.
        const alive = ws && ws.readyState === WebSocket.OPEN && ws.fg === true;
        if (!alive) {
          device.pending = device.pending || [];
          device.pending.push(msg);
        }
        if (device.pending.length > MAX_PENDING_PER_DEVICE) device.pending.splice(0, device.pending.length - MAX_PENDING_PER_DEVICE);
        if (!ok) queued++;
      }
    }
    this.store.saveSync();
    return { sent, queued, offline: targets.length - sent - queued };
  }

  isOnline(deviceId) {
    const ws = this.sockets.get(deviceId);
    return !!ws && ws.readyState === WebSocket.OPEN;
  }
}

export function publicSource(s) {
  const { id, name, color, enabled, kind, defaultPriority } = s;
  return { id, name, color, enabled, kind, defaultPriority, lastAt: s.lastAt || null, count: s.count || 0 };
}
