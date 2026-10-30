// OneBot v11 transport bridge.
//
// OneBot v11 "reverse WebSocket" (Universal client mode) is the common setup:
// the bot framework (NapCat / Lagrange / LLOneBot / go-cqhttp) connects to us
// as a WebSocket client, pushes events as JSON text frames, and accepts API
// calls ("actions") back over that same connection. This module owns:
//
//   * an http.Server for the handshake + /health + HTTP POST event receiver
//   * the set of live WS connections (with echo-based request/response matching)
//   * reply() / callApi() helpers used by the bot logic
//
// Zero external dependencies — uses node:http, node:crypto, global fetch.

import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { attachUpgrade } from './ws.js';

const ACTION_TIMEOUT_MS = 20000;
const HEARTBEAT_INTERVAL_MS = 30000;

export class OneBotBridge extends EventEmitter {
  /**
   * @param {object} cfg - {
   *   host, port, path, accessToken, secret, replyVia, httpApiBase,
   *   httpApiToken, replyAtSender, maxBodyBytes }
   */
  constructor(cfg) {
    super();
    this.cfg = cfg;
    this.connections = new Set();
    this.selfIds = new Set();
    this.pending = new Map(); // echo -> { resolve, reject, timer }
    this.echoSeq = 0;
    this.started = false;
    // Set synchronously in stop() so a stop that races the listen callback
    // still closes the server (see start() — it resolves after this flag).
    this.stopping = false;
    this.heartbeat = null;
    /** @type {import('./setup.js').SetupConsole|null} — attached by index.js */
    this.setup = null;
    this.server = http.createServer((req, res) => this._handleHttp(req, res));
    this.server.on('error', (err) => this.emit('error', err));
    this._removeUpgrade = attachUpgrade(
      this.server,
      { path: cfg.path, accessToken: cfg.accessToken },
      (conn, req) => this._onConnection(conn, req),
    );
  }

  /** Start listening. Resolves once bound. */
  start() {
    return new Promise((resolve, reject) => {
      if (this.started) return resolve(this.server.address());
      if (this.stopping) {
        // stop() ran before the socket was bound; unwind immediately.
        this._closeServer();
        return resolve(null);
      }
      const onError = (err) => reject(err);
      this.server.once('error', onError);
      this.server.listen(this.cfg.port, this.cfg.host, () => {
        this.server.off('error', onError);
        this.started = true;
        if (this.stopping) {
          // Disposed while binding — don't leave the port open.
          this._closeServer();
          return resolve(null);
        }
        // Periodic liveness probe: a connection that missed the last pong is dead.
        this.heartbeat = setInterval(() => {
          for (const conn of this.connections) {
            if (!conn.alive) {
              conn._terminate();
            } else {
              conn.ping();
            }
          }
        }, HEARTBEAT_INTERVAL_MS);
        if (this.heartbeat.unref) this.heartbeat.unref();
        resolve(this.server.address());
      });
    });
  }

  /** Close everything. Safe to call multiple times. */
  stop() {
    return new Promise((resolve) => {
      if (this.heartbeat) {
        clearInterval(this.heartbeat);
        this.heartbeat = null;
      }
      for (const { timer } of this.pending.values()) clearTimeout(timer);
      this.pending.clear();
      for (const conn of this.connections) {
        try { conn._terminate(); } catch { /* ignore */ }
      }
      this.connections.clear();
      if (this._removeUpgrade) {
        try { this._removeUpgrade(); } catch { /* ignore */ }
        this._removeUpgrade = null;
      }
      // Always attempt a close: the listen callback may still be in flight, in
      // which case start() closes it once it lands (see this.stopping).
      this.stopping = true;
      this.started = false;
      this._closeServer();
      // Don't let lingering sockets block shutdown forever.
      const bail = setTimeout(() => resolve(), 2000);
      if (bail.unref) bail.unref();
      this.server.once('close', () => {
        clearTimeout(bail);
        resolve();
      });
    });
  }

  /** Best-effort server close; safe when never bound or already closed. */
  _closeServer() {
    try {
      if (this.server.listening) this.server.close();
    } catch {
      /* ignore — nothing bound or already closed */
    }
  }

  _onConnection(conn, req) {
    this.connections.add(conn);
    const selfId = String(req.headers['x-self-id'] || '');
    if (selfId) this.selfIds.add(selfId);
    const role = String(req.headers['x-client-role'] || 'Universal');
    this.emit('log', `OneBot 客户端已连接 (selfId=${selfId || '未知'}, role=${role})`);

    conn.on('message', (raw) => this._onFrame(conn, raw));
    conn.on('error', (err) => this.emit('log', `OneBot 连接错误: ${err.message}`));
    conn.on('close', () => {
      this.connections.delete(conn);
      this.emit('log', `OneBot 客户端断开 (selfId=${selfId || '未知'})`);
      // Reject anything waiting on this connection's echo.
      for (const [echo, p] of this.pending) {
        if (p.conn === conn) {
          clearTimeout(p.timer);
          this.pending.delete(echo);
          p.reject(new Error('OneBot 连接已断开'));
        }
      }
    });
  }

  _onFrame(conn, raw) {
    let obj;
    try {
      obj = JSON.parse(raw);
    } catch {
      this.emit('log', `忽略无法解析的 OneBot 帧: ${String(raw).slice(0, 120)}`);
      return;
    }
    if (!obj || typeof obj !== 'object') return;

    // An API response carries an echo. Resolve/reject the matching pending
    // action. We also tolerate a response whose echo we no longer track
    // (e.g. it already timed out) by simply ignoring it.
    if (obj.echo !== undefined && obj.echo !== null) {
      const p = this.pending.get(String(obj.echo));
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(String(obj.echo));
        const code = obj.retcode;
        const failed =
          (typeof code === 'number' && code !== 0) ||
          (typeof obj.status === 'string' && obj.status === 'failed');
        if (!failed) p.resolve(obj.data ?? obj);
        else p.reject(new Error(`OneBot 动作失败 (retcode=${code}, ${obj.wording || obj.status || ''})`));
      }
      return;
    }

    // Otherwise it's an event. Track self_id for @-detection in groups.
    if (obj.self_id != null) this.selfIds.add(String(obj.self_id));

    // Emit to the bot logic with a reply function bound to this source.
    const source = { type: 'ws', conn, selfId: obj.self_id };
    this.emit('event', obj, (message, opts) => this.reply(obj, message, { ...opts, source }));
  }

  _handleHttp(req, res) {
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      urlPath = req.url || '/';
    }

    // Health / status endpoint (works on any host header, no auth needed).
    if (req.method === 'GET' && (urlPath === '/health' || urlPath === `${this.cfg.path}/health`)) {
      return sendJson(res, 200, {
        ok: true,
        plugin: '@local/qq-bot',
        started: this.started,
        connections: this.connections.size,
        selfIds: [...this.selfIds],
        replyVia: this.cfg.replyVia,
        path: this.cfg.path,
        setupPath: this.setup ? '/setup' : null,
        reverseUrl: this.setup ? this.setup.reverseUrl() : null,
      });
    }

    // Setup console (扫码登录 / 一键接入) — served on the same port.
    if (this.setup && urlPath === '/setup') return this.setup.handle(req, res, urlPath);
    if (this.setup && urlPath.startsWith('/api/')) return this.setup.handle(req, res, urlPath);

    // OneBot HTTP POST event receiver.
    if (req.method === 'POST' && (urlPath === this.cfg.path || urlPath === '/')) {
      return this._handlePost(req, res);
    }

    sendJson(res, 404, { error: 'Not Found' });
  }

  _handlePost(req, res) {
    // Optional access token check.
    if (this.cfg.accessToken) {
      const auth = req.headers['authorization'] || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      if (bearer !== this.cfg.accessToken) {
        return sendJson(res, 401, { error: 'Unauthorized' });
      }
    }

    const max = this.cfg.maxBodyBytes || 4 * 1024 * 1024;
    const chunks = [];
    let total = 0;
    let aborted = false;
    req.on('data', (chunk) => {
      if (aborted) return;
      total += chunk.length;
      if (total > max) {
        aborted = true;
        sendJson(res, 413, { error: 'Payload Too Large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      const body = Buffer.concat(chunks, total);

      // OneBot HTTP POST signature: X-Signature: sha1=<hmac-sha1(body, secret)>.
      if (this.cfg.secret) {
        const sig = String(req.headers['x-signature'] || '').replace(/^sha1=/i, '');
        const expected = crypto.createHmac('sha1', this.cfg.secret).update(body).digest('hex');
        if (!sig || !timingSafeEqual(sig, expected)) {
          return sendJson(res, 403, { error: 'Forbidden (bad signature)' });
        }
      }

      let obj;
      try {
        obj = JSON.parse(body.toString('utf8'));
      } catch {
        return sendJson(res, 400, { error: 'Invalid JSON' });
      }

      // Respond immediately; the bot reply goes out asynchronously (via the
      // HTTP API base, or over a live WS if one exists). We return {} which is
      // the OneBot "no quick operation" response.
      sendJson(res, 200, {});

      if (obj && typeof obj === 'object') {
        if (obj.self_id != null) this.selfIds.add(String(obj.self_id));
        const source = { type: 'http', selfId: obj.self_id };
        this.emit('event', obj, (message, opts) => this.reply(obj, message, { ...opts, source }));
      }
    });
    req.on('error', () => {
      if (!res.headersSent) sendJson(res, 400, { error: 'Request error' });
    });
  }

  /**
   * Send a reply back for a given incoming event.
   * Chooses transport based on cfg.replyVia and what's available.
   * @returns {Promise<any>}
   */
  async reply(event, message, opts = {}) {
    const params = buildSendParams(event, message, { atSender: opts.atSender ?? this.cfg.replyAtSender });
    if (!params) throw new Error('无法为该事件构造回复参数（缺少 user_id/group_id）');

    const preferHttp = this.cfg.replyVia === 'http' && this.cfg.httpApiBase;
    if (!preferHttp) {
      const conn = opts.source?.conn || this._firstConn();
      if (conn && !conn.closed) {
        try {
          return await this._callWs(conn, 'send_msg', params);
        } catch (err) {
          // Fall back to HTTP API if configured.
          if (this.cfg.httpApiBase) {
            this.emit('log', `WS 回复失败(${err.message})，改用 HTTP API`);
            return await this._callHttp('send_msg', params);
          }
          throw err;
        }
      }
    }
    if (this.cfg.httpApiBase) return await this._callHttp('send_msg', params);
    throw new Error('没有可用的 OneBot 连接来发送回复（WS 未连接且未配置 httpApiBase）');
  }

  /** Call an arbitrary OneBot action over the first live WS connection. */
  callApi(action, params, opts = {}) {
    const conn = opts.source?.conn || this._firstConn();
    if (conn && !conn.closed) return this._callWs(conn, action, params);
    if (this.cfg.httpApiBase) return this._callHttp(action, params);
    return Promise.reject(new Error('没有可用的 OneBot 连接'));
  }

  _firstConn() {
    for (const c of this.connections) if (!c.closed) return c;
    return null;
  }

  _callWs(conn, action, params) {
    const echo = `dsh-${Date.now().toString(36)}-${++this.echoSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error(`OneBot 动作 ${action} 响应超时`));
      }, ACTION_TIMEOUT_MS);
      if (timer.unref) timer.unref();
      this.pending.set(echo, { resolve, reject, timer, conn });
      try {
        conn.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  async _callHttp(action, params) {
    const base = String(this.cfg.httpApiBase).replace(/\/+$/, '');
    const url = `${base}/${action}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ACTION_TIMEOUT_MS);
    try {
      const headers = { 'Content-Type': 'application/json' };
      const token = this.cfg.httpApiToken || this.cfg.accessToken;
      if (token) headers['Authorization'] = `Bearer ${token}`;
      const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(params),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP API ${action} 返回 ${res.status}`);
      const data = await res.json();
      if (data && data.retcode && data.retcode !== 0) {
        throw new Error(`HTTP API ${action} 失败 (retcode=${data.retcode})`);
      }
      return data?.data ?? data;
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Build OneBot send_msg params for an incoming event.
 */
export function buildSendParams(event, message, opts = {}) {
  const mt = event?.message_type;
  let params;
  if (mt === 'private' && event.user_id != null) {
    params = { message_type: 'private', user_id: event.user_id, message };
  } else if (mt === 'group' && event.group_id != null) {
    let msg = message;
    if (opts.atSender && event.user_id != null) {
      msg = `[CQ:at,qq=${event.user_id}] ${message}`;
    }
    params = { message_type: 'group', group_id: event.group_id, message: msg };
  } else if (event?.user_id != null) {
    // Discuss / other — fall back to private.
    params = { message_type: 'private', user_id: event.user_id, message };
  } else {
    return null;
  }
  return params;
}

function sendJson(res, status, obj) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function timingSafeEqual(a, b) {
  try {
    const ab = Buffer.from(String(a), 'hex');
    const bb = Buffer.from(String(b), 'hex');
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  } catch {
    return false;
  }
}
