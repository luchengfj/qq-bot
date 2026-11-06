// Forward WebSocket manager ("零下载" 连接真实 QQ 的关键).
//
// Instead of downloading / installing / launching NapCat, the plugin can act
// as a WebSocket *client* and connect OUT to any already-running OneBot v11
// forward-WS server (NapCat / Lagrange / LLOneBot / go-cqhttp ...). Events
// from that server flow through the exact same BotLogic pipeline as reverse-WS
// events, and replies go back over that same connection.
//
// The runtime-configured URL is persisted to a small JSON file so it survives
// a plugin reload; the patch's `forward:` block is the initial default.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { connectWebSocket } from './ws.js';

const DEFAULT_RECONNECT_MS = 5000;

export function defaultStorePath() {
  return path.join(os.homedir(), '.dsh', 'qq-bot-forward.json');
}

/** Validate a forward-WS target. Returns a normalized URL or throws. */
export function normalizeForwardUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) throw new Error('请填写正向 WebSocket 地址（例如 ws://127.0.0.1:3001/）');
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`地址格式不正确：${value}`);
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error('地址必须以 ws:// 或 wss:// 开头（这是 OneBot 正向 WebSocket，不是 http）');
  }
  if (!parsed.hostname) throw new Error('地址缺少主机名');
  if (parsed.username || parsed.password) throw new Error('地址里不能包含用户名/密码');
  return `${parsed.protocol}//${parsed.host}${parsed.pathname || '/'}${parsed.search || ''}`;
}

export class ForwardManager extends EventEmitter {
  /**
   * @param {import('./onebot.js').OneBotBridge} bridge
   * @param {(msg: string) => void} log
   * @param {{ storePath?: string }} options
   */
  constructor(bridge, log = () => {}, options = {}) {
    super();
    this.bridge = bridge;
    this.log = log;
    this.storePath = options.storePath || defaultStorePath();
    this.state = { enabled: false, url: '', accessToken: '', reconnectMs: DEFAULT_RECONNECT_MS };
    this.conn = null;
    this.status = 'idle'; // idle | disabled | connecting | connected | disconnected | error
    this.lastError = '';
    this.lastConnectAt = 0;
    this.stopped = true;
    this.connecting = false;
    this.retryTimer = null;
  }

  /** Shape consumed by the DSH panel (/status + /forward-config). */
  info() {
    return {
      enabled: Boolean(this.state.enabled),
      url: this.state.url,
      connected: Boolean(this.conn && !this.conn.closed),
      status: this.status,
      lastError: this.lastError,
      lastConnectAt: this.lastConnectAt,
      reconnectMs: this.state.reconnectMs,
    };
  }

  /**
   * Seed from the patch config, then overlay a previously persisted runtime
   * config (panel wins). Starts connecting when enabled + a URL is present.
   */
  init(cfgForward = {}) {
    const base = {
      enabled: cfgForward.enabled === true,
      url: String(cfgForward.url || ''),
      accessToken: String(cfgForward.accessToken || ''),
      reconnectMs: Number(cfgForward.reconnectMs) || DEFAULT_RECONNECT_MS,
    };
    try {
      const stored = JSON.parse(fs.readFileSync(this.storePath, 'utf8'));
      if (stored && typeof stored === 'object' && typeof stored.url === 'string') {
        base.url = stored.url;
        base.accessToken = String(stored.accessToken || '');
        base.enabled = stored.enabled !== false;
      }
    } catch {
      /* no persisted config (or unreadable) — use the patch defaults */
    }
    this.state = base;
    this.stopped = false;
    if (this.state.enabled && this.state.url) {
      this.connect();
    } else {
      this.status = this.state.url ? 'disabled' : 'idle';
    }
    return this.info();
  }

  /** Apply a panel-supplied config. Persists it so it survives a reload. */
  configure(body = {}) {
    const url = normalizeForwardUrl(body.url);
    const accessToken = String(body.accessToken ?? body.token ?? '').trim();
    const enabled = body.enabled !== false;
    this._clearRetry();
    // Drop the current connection before switching targets.
    const old = this.conn;
    this.conn = null;
    if (old) {
      try { old._terminate(); } catch { /* ignore */ }
    }
    this.state = {
      enabled,
      url,
      accessToken,
      reconnectMs: this.state.reconnectMs || DEFAULT_RECONNECT_MS,
    };
    this.lastError = '';
    this.stopped = false;
    this._persist();
    this.log(`正向 WebSocket 目标已设置: ${url}`);
    if (enabled) this.connect();
    else this.status = 'disabled';
    return this.info();
  }

  /** Explicitly disconnect and stay disconnected until reconfigured. */
  disconnect() {
    this._clearRetry();
    this.state.enabled = false;
    const old = this.conn;
    this.conn = null;
    if (old) {
      try { old._terminate(); } catch { /* ignore */ }
    }
    this.status = 'disabled';
    this._persist();
    this.log('正向 WebSocket 已断开');
    return this.info();
  }

  async connect() {
    if (this.stopped || this.connecting) return this.info();
    if (!this.state.url || !this.state.enabled) return this.info();
    this.connecting = true;
    this.status = 'connecting';
    this.lastError = '';
    try {
      const conn = await connectWebSocket(this.state.url, {
        accessToken: this.state.accessToken,
        timeoutMs: 10000,
      });
      this.connecting = false;
      if (this.stopped) {
        try { conn._terminate(); } catch { /* ignore */ }
        return this.info();
      }
      this.conn = conn;
      this.status = 'connected';
      this.lastConnectAt = Date.now();
      this.log(`正向 WebSocket 已连接: ${this.state.url}`);
      // Reuse the bridge's connection pipeline: events -> BotLogic, and
      // replies -> this very connection (echo-matched API calls).
      this.bridge.attachConnection(conn, { selfId: '', role: 'Forward' });
      conn.on('error', (err) => {
        this.lastError = err.message;
        this.log(`正向 WebSocket 错误: ${err.message}`);
      });
      conn.on('close', () => {
        if (this.conn === conn) this.conn = null;
        if (this.stopped || !this.state.enabled) {
          this.status = this.stopped ? 'idle' : 'disabled';
          return;
        }
        this.status = 'disconnected';
        this.log('正向 WebSocket 已断开，将自动重连');
        this._scheduleReconnect();
      });
      this.emit('connected', conn);
    } catch (err) {
      this.connecting = false;
      this.lastError = err.message;
      this.status = 'error';
      this.log(`正向 WebSocket 连接失败: ${err.message}`);
      this._scheduleReconnect();
    }
    return this.info();
  }

  _scheduleReconnect() {
    if (this.stopped || !this.state.enabled || !this.state.url || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, this.state.reconnectMs);
    if (this.retryTimer.unref) this.retryTimer.unref();
  }

  _clearRetry() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  _persist() {
    try {
      fs.mkdirSync(path.dirname(this.storePath), { recursive: true });
      fs.writeFileSync(
        this.storePath,
        JSON.stringify({
          enabled: this.state.enabled,
          url: this.state.url,
          accessToken: this.state.accessToken,
        }, null, 2) + '\n',
        'utf8',
      );
    } catch (err) {
      this.log(`正向连接配置未能保存（仅本次有效）: ${err.message}`);
    }
  }

  /** Called on plugin unload. */
  dispose() {
    this.stopped = true;
    this._clearRetry();
    const old = this.conn;
    this.conn = null;
    if (old) {
      try { old._terminate(); } catch { /* ignore */ }
    }
    this.status = 'idle';
  }
}
