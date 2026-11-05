// Setup console: a tiny built-in web page that lets the user scan a QQ login
// QR code and wire NapCat back to this plugin with one click.
//
// Routes are served by the plugin's own http.Server (same port as the OneBot
// endpoint) and are intentionally plain: no bundler, no framework, no external
// assets. Everything is inline HTML/CSS/JS.
//
//   GET  /setup              -> the console page
//   GET  /api/status         -> plugin + NapCat state
//   POST /api/qr             -> { url, svg, expiresAt }  (fresh login QR)
//   GET  /api/qr.svg         -> the current QR rendered as SVG
//   POST /api/link           -> write the reverse-WS entry into NapCat
//   POST /api/login-info     -> { isLogin, uin, ... }
//
// When cfg.accessToken is set, every /api/* call and the page itself require it
// (query ?token=... or an Authorization: Bearer header), because these routes
// can mutate the NapCat configuration.

import { NapCatClient, reverseWsUrl } from './napcat.js';
import { encode, toSvg } from './qr.js';
import { renderPage } from './setup-page.js';
import { findSync } from './discovery.js';

const SETUP_PATH = '/setup';
const QR_TTL_MS = 115000;

function trimTrailingSlash(value) {
  let s = String(value);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export class SetupConsole {
  /**
   * @param {object} cfg - normalized plugin config
   * @param {import('./onebot.js').OneBotBridge} bridge
   * @param {(msg:string)=>void} log
   */
  constructor(cfg, bridge, log = () => {}) {
    this.cfg = cfg;
    this.bridge = bridge;
    this.log = log;
    const nap = cfg.napcat || {};

    // NapCat generates a random webui token on first boot. When the patch has
    // an empty webuiToken (the default), discover it from webui.json / env so
    // QR + 一键接入 work without any manual copy-paste.
    const discovered = findSync({
      napcatDir: nap.napcatDir || '',
      configuredPort: nap.webuiPort || 6099,
      baseUrl: nap.baseUrl || '',
      configuredToken: nap.webuiToken || '',
    });
    this.discovery = discovered;
    this.discoveryCheckedAt = Date.now();
    // Keep a client object even when napcat.enabled is false: then QR/link
    // calls go through ensureReady(), which re-runs discovery and either binds
    // a token or returns an actionable 503 with hints. `napcatDisabled`
    // records the explicit opt-out for status() / diagnostics.
    this.napcatDisabled = nap.enabled === false;
    this.napcat = new NapCatClient({
      baseUrl: discovered.found ? discovered.webuiUrl : (nap.baseUrl || 'http://127.0.0.1:6099'),
      token: discovered.found ? discovered.token : (nap.webuiToken || ''),
      tokenSource: discovered.tokenSource,
      timeoutMs: nap.timeoutMs || 15000,
    });
    if (discovered.found && discovered.tokenSource !== 'config') {
      this.log(`自动发现 NapCat WebUI 令牌 (来源: ${discovered.tokenSource}, WebUI: ${discovered.webuiUrl})`);
    } else if (!discovered.found) {
      this.log(`暂未发现 NapCat WebUI 令牌：${discovered.hints.join('；')}`);
    }
    this.qr = null; // { url, svg, expiresAt }
  }

  /** Re-run discovery (e.g. after the user launches NapCat) and rebind the client. */
  refreshDiscovery() {
    const nap = this.cfg.napcat || {};
    const d = findSync({
      napcatDir: nap.napcatDir || '',
      configuredPort: nap.webuiPort || 6099,
      baseUrl: nap.baseUrl || '',
      configuredToken: nap.webuiToken || '',
    });
    this.discovery = d;
    this.discoveryCheckedAt = Date.now();
    if (this.napcat) {
      if (d.found) {
        this.napcat.setBaseUrl(d.webuiUrl);
        this.napcat.setToken(d.token, d.tokenSource);
      }
    }
    return d;
  }

  get enabled() {
    // Exposed only when a NapCat WebUI was configured; otherwise the page
    // still loads and explains how to configure one.
    return true;
  }

  /** Reverse-WS URL NapCat should dial, derived from our own listener. */
  reverseUrl() {
    const nap = this.cfg.napcat || {};
    return reverseWsUrl(this.cfg, {
      host: nap.reverseHost || '127.0.0.1',
      port: nap.reversePort || this.cfg.port,
      path: this.cfg.path,
      token: this.cfg.accessToken,
    });
  }

  /** Called from OneBotBridge._handleHttp. Returns true when handled. */
  handle(req, res, urlPath) {
    if (req.method === 'GET' && urlPath === SETUP_PATH) return this._page(req, res);
    if (!urlPath.startsWith('/api/')) return false;
    if (!this._authorized(req, res)) return true;

    if (urlPath === '/api/status' && req.method === 'GET') return this._json(res, 200, this.status());
    if (urlPath === '/api/qr.svg' && req.method === 'GET') return this._qrSvg(req, res);
    if (urlPath === '/api/qr' && req.method === 'POST') return this._void(res, this._newQr(res));
    if (urlPath === '/api/login-info' && req.method === 'POST') return this._void(res, this._loginInfo(res));
    if (urlPath === '/api/link' && req.method === 'POST') return this._void(res, this._link(res));
    return this._json(res, 404, { error: 'Not Found' });
  }

  status() {
    return {
      ok: true,
      plugin: '@local/qq-bot',
      started: this.bridge.started,
      connections: this.bridge.connections.size,
      selfIds: [...this.bridge.selfIds],
      endpoint: {
        host: this.cfg.host,
        port: this.cfg.port,
        path: this.cfg.path,
        replyVia: this.cfg.replyVia,
      },
      reverseUrl: this.reverseUrl(),
      napcat: {
        configured: Boolean(this.napcat),
        baseUrl: this.napcat ? this.napcat.baseUrl : null,
        hasToken: Boolean(this.napcat && this.napcat.token),
        tokenFound: this.discovery.found,
        tokenSource: this.discovery.tokenSource,
        webuiPort: this.discovery.webuiPort,
        configPath: this.discovery.configPath,
        onebot11Path: this.discovery.onebot11Path,
        napcatDir: this.discovery.napcatDir,
        hints: this.discovery.hints,
      },
      llm: {
        mode: this.cfg.llm?.mode === 'external' ? 'external' : 'harness',
        baseUrl: this.cfg.llm?.baseUrl || '',
        model: this.cfg.llm?.model || '',
        hasKey: Boolean(this.cfg.llm?.apiKey),
      },
      login: {
        isLogin: this.bridge.selfIds.size > 0,
        uin: [...this.bridge.selfIds][0] || null,
      },
      qr: this.qr && this.qr.expiresAt > Date.now()
        ? { url: this.qr.url, expiresAt: this.qr.expiresAt }
        : null,
    };
  }

  _authorized(req, res) {
    const token = this.cfg.accessToken || '';
    if (!token) {
      // No token configured: only expose the console to loopback callers.
      const ip = (req.socket?.remoteAddress || '').replace(/^::ffff:/, '');
      if (ip === '127.0.0.1' || ip === '::1' || ip === '') return true;
      this._json(res, 403, { error: 'Forbidden (remote access denied)' });
      return false;
    }
    const auth = String(req.headers.authorization || '');
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    let query = '';
    try {
      query = new URL(req.url, 'http://localhost').searchParams.get('token') || '';
    } catch { /* ignore */ }
    if (bearer === token || query === token) return true;
    this._json(res, 401, { error: 'Unauthorized' });
    return false;
  }

  /**
   * Refresh token discovery and throw a friendly, hint-carrying error when
   * NapCat is not ready yet. Shared by the standalone console and the DSH
   * panel bridge so both surfaces explain the same fix instead of showing a
   * bare "未配置令牌" 502.
   */
  ensureReady() {
    this.refreshDiscovery();
    if (!this.napcat || (this.napcatDisabled && !this.napcat.token)) {
      const err = new Error('NapCat WebUI 已在配置里关闭（napcat.enabled: false）：如要使用扫码登录与一键接入，请把它改回 true。');
      err.hints = this.discovery.hints;
      err.status = 400;
      throw err;
    }
    if (!this.napcat.token) {
      const err = new Error('尚未发现 NapCat WebUI 令牌：请先启动 NapCat（运行 NapCatInstaller.exe 后执行 napcat.bat），或在 cordis.patch.yml 填 napcat.webuiToken。');
      err.hints = this.discovery.hints;
      err.status = 503;
      throw err;
    }
    return this.napcat;
  }

  /**
   * Fetch a fresh login QR code from NapCat and cache its rendered SVG.
   * Shared by the standalone console and by the DSH panel bridge.
   * @returns {Promise<{logined: boolean, uin?: string, qr?: {url: string, expiresAt: number}}>}
   */
  async newQr() {
    const nap = this.ensureReady();
    const info = await nap.loginInfo();
    if (info.isLogin) {
      this.qr = null;
      return { logined: true, uin: info.uin, qr: null };
    }
    const { url } = await nap.getQrcode();
    const encoded = encode(url, 'M');
    this.qr = {
      url,
      encoded,
      svg: toSvg(encoded, { scale: 8 }),
      expiresAt: Date.now() + QR_TTL_MS,
    };
    this.log(`已生成登录二维码 (${url.length} 字节)`);
    return { logined: false, qr: { url, expiresAt: this.qr.expiresAt } };
  }

  async _newQr(res) {
    try {
      const result = await this.newQr();
      return this._json(res, 200, result);
    } catch (err) {
      return this._json(res, err.status || 502, { ok: false, error: err.message, hints: err.hints || [] });
    }
  }

  _qrSvg(req, res) {
    if (!this.qr || this.qr.expiresAt <= Date.now()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('二维码已过期，请刷新');
      return true;
    }
    const body = this.qr.svg;
    res.writeHead(200, {
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  }

  async _loginInfo(res) {
    try {
      const nap = this.ensureReady();
      const info = await nap.loginInfo();
      return this._json(res, 200, info);
    } catch (err) {
      return this._json(res, err.status || 502, { ok: false, error: err.message, hints: err.hints || [] });
    }
  }

  async _link(res) {
    try {
      const nap = this.ensureReady();
      const result = await nap.linkReverseWebSocket({
        url: this.reverseUrl(),
        token: this.cfg.accessToken || '',
        name: 'dsh-qq-bot',
      });
      this.log(`已写入 NapCat 反向 WebSocket: ${result.url} (新增=${result.added})`);
      return this._json(res, 200, { ok: true, ...result });
    } catch (err) {
      return this._json(res, err.status || 502, { ok: false, error: err.message, hints: err.hints || [] });
    }
  }

  _json(res, status, obj) {
    if (res.headersSent) return true;
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  }

  _void(res, promise) {
    Promise.resolve(promise).catch((err) => {
      this.log(`控制台接口异常: ${err.message}`);
      if (!res.headersSent) this._json(res, 500, { error: err.message });
    });
    return true;
  }

  _page(req, res) {
    const body = renderPage(this.cfg, this.reverseUrl());
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    });
    res.end(body);
    return true;
  }
}

// The standalone console markup lives in its own module so the server file
// stays focused on routing. Kept as a named export for test/back-compat.
export { renderPage } from './setup-page.js';
