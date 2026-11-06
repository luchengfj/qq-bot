// 本机 OneBot 端口自动探测（「零下载」的「连地址都不用手填」能力）。
//
// 插件启动时扫描本机常见 OneBot 正向 WebSocket 端口 / 路径，用一条
// OneBot v11 `get_version` 动作确认对方确实是 OneBot 实现，然后借助
// ForwardManager 自动连上。插件自己不下载、不安装、不启动任何 QQ 端。
//
// 安全约束：
//   * 永远排除插件自身的监听端口（否则会连回自己造成事件回环）；
//   * 已经配置了正向地址时绝不覆盖（用户手动填的地址优先）；
//   * 探测只连 127.0.0.1，所有定时器 unref，不阻塞进程退出。

import { EventEmitter } from 'node:events';
import { connectWebSocket } from './ws.js';

const PROBE_ECHO = 'qq-bot-detect';

const DEFAULTS = {
  enabled: true,
  host: '127.0.0.1',
  ports: [3001, 3000, 5700, 8080, 6099, 3333],
  paths: ['/', '/onebot'],
  intervalMs: 20000,
  timeoutMs: 1500,
  accessToken: '',
  excludePorts: [],
};

function toInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

function cleanPorts(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice();
  const out = [];
  for (const raw of value) {
    const n = Number(raw);
    if (Number.isInteger(n) && n >= 1 && n <= 65535 && !out.includes(n)) out.push(n);
    if (out.length >= 40) break;
  }
  return out.length ? out : fallback.slice();
}

function cleanPaths(value, fallback) {
  if (!Array.isArray(value)) return fallback.slice();
  const out = [];
  for (const raw of value) {
    let p = String(raw || '').trim();
    if (!p) continue;
    if (!p.startsWith('/')) p = `/${p}`;
    if (p.length > 1) p = p.replace(/\/+$/, '');
    if (!out.includes(p)) out.push(p);
    if (out.length >= 10) break;
  }
  return out.length ? out : fallback.slice();
}

/**
 * 探测单个候选地址是不是一个真的 OneBot v11 正向 WebSocket 服务。
 *
 * 完成 WebSocket 握手后发 `get_version`，等待带相同 echo 的响应；也接受
 * 连接后主动推送的 lifecycle / meta_event / message 事件作为正信号（部分
 * 实现在鉴权前不发 API 响应）。纯 echo 服务（把我们发的原样退回）不算。
 *
 * 本函数**永不抛错、永不 reject**：失败也 resolve 成 {ok:false, reason}。
 *
 * @param {string} url ws:// 或 wss:// 地址
 * @param {{ accessToken?: string, timeoutMs?: number }} options
 * @returns {Promise<{ok:boolean,url:string,appName?:string,version?:string,selfId?:string|number,reason?:string}>}
 */
export function probeOneBot(url, options = {}) {
  const timeoutMs = toInt(options.timeoutMs, DEFAULTS.timeoutMs, 200, 10000);
  return new Promise((resolve) => {
    let conn = null;
    let timer = null;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (conn) {
        try { conn.removeAllListeners('message'); } catch { /* ignore */ }
        try { conn.removeAllListeners('error'); } catch { /* ignore */ }
        try { conn.removeAllListeners('close'); } catch { /* ignore */ }
        try { conn._terminate(); } catch { /* ignore */ }
      }
      resolve({ ok: false, url, ...result });
    };

    const onMessage = (raw) => {
      let obj;
      try { obj = JSON.parse(raw); } catch { return; }
      if (!obj || typeof obj !== 'object') return;

      let hit = null;
      if (obj.echo === PROBE_ECHO) {
        // 纯 echo 服务会把 {action,echo,params} 原样退回；真正的 OneBot
        // 响应一定带 data / retcode / status / wording 之一。
        if (obj.data || typeof obj.retcode === 'number' || obj.status || obj.wording) {
          hit = {
            appName: (obj.data && (obj.data.app_name || obj.data.appName)) || '',
            version: (obj.data && (obj.data.app_version || obj.data.protocol_version)) || '',
          };
        }
      } else if (
        obj.post_type === 'meta_event' || obj.meta_event_type === 'lifecycle' ||
        obj.post_type === 'message' || obj.post_type === 'notice' ||
        obj.post_type === 'request'
      ) {
        hit = { appName: 'OneBot', version: '' };
      } else if (obj.data && obj.retcode === 0) {
        hit = {
          appName: obj.data.app_name || '',
          version: obj.data.app_version || '',
        };
      }
      if (hit) {
        finish({
          ok: true,
          appName: hit.appName,
          version: hit.version,
          selfId: obj.self_id ?? (obj.data && obj.data.self_id) ?? '',
        });
      }
    };

    connectWebSocket(url, {
      accessToken: options.accessToken || '',
      timeoutMs,
    }).then((c) => {
      if (settled) {
        try { c._terminate(); } catch { /* ignore */ }
        return;
      }
      conn = c;
      // WsConnection 只在有 error 监听器时才 emit('error')，这里始终挂一个，
      // 避免探测期出现未处理的 socket 错误。
      c.on('message', onMessage);
      c.on('error', () => {});
      c.on('close', () => {});
      try {
        c.send(JSON.stringify({ action: 'get_version', echo: PROBE_ECHO, params: {} }));
      } catch { /* ignore */ }
      if (settled) return;
      timer = setTimeout(
        () => finish({ reason: '未收到 OneBot 探测响应' }),
        timeoutMs,
      );
      if (timer.unref) timer.unref();
    }).catch((err) => {
      finish({ reason: err && err.message ? err.message : String(err) });
    });
  });
}

/**
 * 周期性扫描本机常见 OneBot 端口并在找到时自动连接。
 *
 * @param {import('./forward.js').ForwardManager} forward
 * @param {(msg: string) => void} log
 * @param {{ selfPort?: number }} options - selfPort = 插件自身监听端口，必须排除
 */
export class AutoDetector extends EventEmitter {
  constructor(forward, log = () => {}, options = {}) {
    super();
    this.forward = forward;
    this.log = log;
    this.selfPort = Number(options.selfPort) || 0;
    this.config = {
      ...DEFAULTS,
      ports: DEFAULTS.ports.slice(),
      paths: DEFAULTS.paths.slice(),
      excludePorts: [],
    };
    this.enabled = true;
    this.running = false;
    this.scanning = false;
    this.status = 'idle'; // idle | scanning | found | disabled | error
    this.lastScanAt = 0;
    this.lastFound = null;
    this.candidates = [];
    this.timer = null;
    this.stopped = true;
  }

  /** 被 DSH 面板 /status 与 /detect-* 消费的形状。 */
  info() {
    const excluded = this.config.excludePorts.slice();
    if (this.selfPort && !excluded.includes(this.selfPort)) excluded.push(this.selfPort);
    return {
      enabled: this.enabled,
      running: this.running,
      scanning: this.scanning,
      status: this.status,
      lastScanAt: this.lastScanAt,
      lastFound: this.lastFound,
      candidates: this.candidates.slice(),
      ports: this.config.ports.slice(),
      paths: this.config.paths.slice(),
      excludedPorts: excluded,
      intervalMs: this.config.intervalMs,
      timeoutMs: this.config.timeoutMs,
      host: this.config.host,
    };
  }

  /** 用 patch 的 `detect:` 块初始化（不启动定时器；由 start() 负责）。 */
  init(cfgDetect = {}) {
    const raw = cfgDetect || {};
    this.config = {
      enabled: raw.enabled !== false,
      host: typeof raw.host === 'string' && raw.host.trim() ? raw.host.trim() : DEFAULTS.host,
      ports: cleanPorts(raw.ports, DEFAULTS.ports),
      paths: cleanPaths(raw.paths, DEFAULTS.paths),
      intervalMs: toInt(raw.intervalMs, DEFAULTS.intervalMs, 2000, 600000),
      timeoutMs: toInt(raw.timeoutMs, DEFAULTS.timeoutMs, 200, 10000),
      accessToken: String(raw.accessToken || ''),
      excludePorts: cleanPorts(raw.excludePorts, []),
    };
    this.enabled = this.config.enabled;
    this.status = this.enabled ? 'idle' : 'disabled';
    this.stopped = false;
    return this.info();
  }

  /** 启动周期扫描 + 立刻扫一次。 */
  start() {
    if (this.stopped) return this.info();
    if (!this.enabled) {
      this.status = 'disabled';
      return this.info();
    }
    this._schedule();
    // 首次扫描异步进行，不阻塞插件启动。
    this.scanNow().catch((err) => this.log(`自动探测扫描异常: ${err.message}`));
    return this.info();
  }

  _schedule() {
    this._clearTimer();
    this.running = true;
    this.timer = setInterval(() => {
      if (this.enabled && !this.scanning) {
        this.scanNow().catch((err) => this.log(`自动探测扫描异常: ${err.message}`));
      }
    }, this.config.intervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  _clearTimer() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
  }

  /**
   * 立即扫一轮。这是面板「立即扫描」按钮调用的动作，因此即便自动探测被
   * 关闭也允许扫描（只是不会自动连接），方便用户看结果。
   */
  async scanNow() {
    if (this.scanning) return { ok: true, detect: this.info(), hits: this.candidates.slice() };
    this.scanning = true;
    if (this.status !== 'disabled') this.status = 'scanning';
    this.emit('scan-start');
    const excluded = this.config.excludePorts.slice();
    if (this.selfPort && !excluded.includes(this.selfPort)) excluded.push(this.selfPort);

    const tasks = [];
    for (const port of this.config.ports) {
      if (excluded.includes(port)) continue;
      for (const p of this.config.paths) {
        tasks.push({
          port,
          url: `ws://${this.config.host}:${port}${p}`,
        });
      }
    }

    let results = [];
    try {
      // probeOneBot 永不 reject；并发探测让本机一轮扫描在毫秒级完成。
      const settled = await Promise.all(
        tasks.map((t) => probeOneBot(t.url, {
          accessToken: this.config.accessToken,
          timeoutMs: this.config.timeoutMs,
        })),
      );
      // 每个端口只保留第一个命中，按端口顺序去重。
      const seen = new Set();
      for (let i = 0; i < settled.length; i += 1) {
        const r = settled[i];
        if (!r || !r.ok) continue;
        const port = tasks[i].port;
        if (seen.has(port)) continue;
        seen.add(port);
        results.push({ ...r, port });
      }
      this.candidates = results;
      this.lastScanAt = Date.now();
      if (results.length) {
        this.status = this.enabled ? 'found' : 'disabled';
        this.lastFound = results[0];
        if (this.enabled && this._canAutoConnect()) {
          const hit = results[0];
          try {
            this.forward.configure({
              url: hit.url,
              accessToken: this.config.accessToken,
              enabled: true,
            });
            this.log(`自动探测到本机 OneBot 端：${hit.url}${hit.appName ? ` (${hit.appName})` : ''}，已自动连接`);
            this.emit('found', hit);
          } catch (err) {
            this.log(`自动探测找到 ${hit.url}，但连接失败：${err.message}`);
          }
        } else if (this.enabled) {
          this.log(`自动探测到 ${results.length} 个候选，但已存在正向地址，未覆盖手动配置`);
        }
      } else {
        this.status = this.enabled ? 'idle' : 'disabled';
      }
    } catch (err) {
      this.status = 'error';
      this.log(`自动探测失败: ${err && err.message ? err.message : String(err)}`);
    } finally {
      this.scanning = false;
      this.emit('scan-done', results);
    }
    return { ok: true, detect: this.info(), hits: results };
  }

  /** 已经连着、或已经配置了任何正向地址时，都不自动覆盖。 */
  _canAutoConnect() {
    const info = this.forward && typeof this.forward.info === 'function'
      ? this.forward.info()
      : null;
    if (!info) return false;
    if (info.connected) return false;
    if (info.url) return false;
    return true;
  }

  /** 面板开关：开 = 周期扫描 + 允许自动连接；关 = 只停周期/自动连接。 */
  setEnabled(value) {
    const next = value !== false;
    this.enabled = next;
    this.config.enabled = next;
    if (next) {
      this.status = this.lastFound ? 'found' : 'idle';
      this._schedule();
      this.log('本机 OneBot 端口自动探测已开启');
    } else {
      this._clearTimer();
      this.status = 'disabled';
      this.log('本机 OneBot 端口自动探测已关闭');
    }
    return this.info();
  }

  /** 插件卸载时调用：清定时器、标记停止、释放监听器。 */
  dispose() {
    this.stopped = true;
    this._clearTimer();
    this.scanning = false;
    this.status = 'idle';
    try { this.removeAllListeners(); } catch { /* ignore */ }
  }
}
