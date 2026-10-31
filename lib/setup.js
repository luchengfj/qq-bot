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
    this.napcat = nap.enabled === false ? null : new NapCatClient({
      baseUrl: nap.baseUrl || 'http://127.0.0.1:6099',
      token: nap.webuiToken || '',
      timeoutMs: nap.timeoutMs || 15000,
    });
    this.qr = null; // { url, svg, expiresAt }
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
      },
      llm: {
        mode: this.cfg.llm?.mode === 'external' ? 'external' : 'harness',
        baseUrl: this.cfg.llm?.baseUrl || '',
        model: this.cfg.llm?.model || '',
        hasKey: Boolean(this.cfg.llm?.apiKey),
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
   * Fetch a fresh login QR code from NapCat and cache its rendered SVG.
   * Shared by the standalone console and by the DSH panel bridge.
   * @returns {Promise<{logined: boolean, uin?: string, qr?: {url: string, expiresAt: number}}>}
   */
  async newQr() {
    if (!this.napcat) throw new Error('未配置 NapCat WebUI (napcat.baseUrl / napcat.enabled)');
    const info = await this.napcat.loginInfo();
    if (info.isLogin) {
      this.qr = null;
      return { logined: true, uin: info.uin, qr: null };
    }
    const { url } = await this.napcat.getQrcode();
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
      return this._json(res, 502, { error: err.message });
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
    if (!this.napcat) return this._json(res, 400, { error: '未配置 NapCat WebUI' });
    try {
      const info = await this.napcat.loginInfo();
      return this._json(res, 200, info);
    } catch (err) {
      return this._json(res, 502, { error: err.message });
    }
  }

  async _link(res) {
    if (!this.napcat) return this._json(res, 400, { error: '未配置 NapCat WebUI' });
    try {
      const result = await this.napcat.linkReverseWebSocket({
        url: this.reverseUrl(),
        token: this.cfg.accessToken || '',
        name: 'dsh-qq-bot',
      });
      this.log(`已写入 NapCat 反向 WebSocket: ${result.url} (新增=${result.added})`);
      return this._json(res, 200, { ok: true, ...result });
    } catch (err) {
      return this._json(res, 502, { error: err.message });
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

/**
 * Render the console page. The `token` (if any) is injected so the page's own
 * fetch calls can authorize themselves.
 */
export function renderPage(cfg, reverseUrl) {
  const token = cfg.accessToken || '';
  const esc = (s) => String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  const nap = cfg.napcat || {};
  const baseUrl = esc(nap.baseUrl || 'http://127.0.0.1:6099');
  const hasNapcat = nap.enabled !== false;

  return [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>QQ 机器人 · 扫码登录与一键接入</title>',
    '<style>',
    ':root{--bg:#0f172a;--card:#1e293b;--fg:#e2e8f0;--muted:#94a3b8;--ok:#22c55e;--warn:#f59e0b;--err:#ef4444;--accent:#38bdf8}',
    '*{box-sizing:border-box}',
    'body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.wrap{max-width:760px;margin:0 auto;display:grid;gap:16px}',
    'h1{font-size:20px;margin:0}',
    '.card{background:var(--card);border-radius:12px;padding:16px 18px}',
    '.row{display:flex;gap:12px;align-items:center;flex-wrap:wrap}',
    'button{background:var(--accent);color:#08131f;border:0;border-radius:8px;padding:8px 14px;font-weight:600;cursor:pointer}',
    'button[disabled]{opacity:.5;cursor:default}',
    'button.ghost{background:transparent;color:var(--fg);border:1px solid #475569}',
    'code,pre{background:#0b1220;border-radius:6px;padding:2px 6px;font-size:12.5px;word-break:break-all}',
    'pre{padding:10px;overflow:auto}',
    '.muted{color:var(--muted)}',
    '.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:12px;background:#0b1220;color:var(--muted)}',
    '.pill.ok{color:var(--ok)}.pill.warn{color:var(--warn)}.pill.err{color:var(--err)}',
    '.qr{display:grid;place-items:center;min-height:280px;background:#fff;border-radius:12px;padding:12px}',
    '.qr img{width:260px;height:260px;image-rendering:pixelated}',
    'dl{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}',
    'dt{color:var(--muted)}dd{margin:0}',
    '</style>',
    '</head>',
    '<body>',
    '<div class="wrap">',
    '<div class="card"><h1>QQ 机器人 · 扫码登录与一键接入</h1>',
    '<p class="muted" style="margin:6px 0 0">DeepSeek Harness 插件 <code>@local/qq-bot</code>。下面两步完成后，NapCat 就会把 QQ 消息转送到本插件。</p></div>',

    '<div class="card">',
    '<div class="row"><strong>1. 连接状态</strong><span id="conn" class="pill">…</span><span id="llm" class="pill">…</span></div>',
    '<dl style="margin-top:10px">',
    '<dt>本插件端点</dt><dd><code>' + esc(cfg.host) + ':' + esc(cfg.port) + esc(cfg.path) + '</code></dd>',
    '<dt>反向 WS 地址</dt><dd><code id="revurl">' + esc(reverseUrl) + '</code></dd>',
    '<dt>NapCat WebUI</dt><dd><code>' + baseUrl + '</code>' + (hasNapcat ? '' : ' <span class="pill warn">未启用</span>') + '</dd>',
    '</dl>',
    '</div>',

    '<div class="card">',
    '<div class="row"><strong>2. 扫码登录 QQ</strong>',
    '<button id="btnQr">获取二维码</button>',
    '<button id="btnRefresh" class="ghost" disabled>刷新二维码</button>',
    '<span id="loginState" class="pill">未登录</span></div>',
    '<div class="qr" id="qrBox" style="margin-top:12px"><span class="muted">点击「获取二维码」后用手机 QQ 扫码</span></div>',
    '<p class="muted" id="qrHint" style="margin:8px 0 0"></p>',
    '</div>',

    '<div class="card">',
    '<div class="row"><strong>3. 一键接入</strong><button id="btnLink">写入 NapCat 反向 WebSocket</button><span id="linkState" class="pill">未接入</span></div>',
    '<p class="muted" style="margin:8px 0 0">这一步会把上面的地址写入 NapCat 的 <code>onebot11.json</code>（<code>network.websocketClients</code>），NapCat 随后会自动连回来。其他传输方式不会被改动。</p>',
    '</div>',

    '<div class="card"><strong>4. 手动接入（备用）</strong>',
    '<p class="muted" style="margin:6px 0">如果不想让插件改 NapCat 配置，可在 NapCat WebUI → 网络配置 → 新建 WebSocket 客户端，地址填：</p>',
    '<pre>' + esc(reverseUrl) + '</pre>',
    '<p class="muted">或在 <code>napcat/config/onebot11.json</code> 的 <code>network.websocketClients</code> 里加入 <code>{"name":"dsh-qq-bot","enable":true,"url":"' + esc(reverseUrl) + '","messagePostFormat":"array","token":"","heartInterval":30000,"reconnectInterval":5000,"reportSelfMessage":false,"debug":false}</code></p>',
    '</div>',
    '</div>',

    '<script>',
    'const TOKEN = ' + JSON.stringify(token) + ';',
    'const qs = TOKEN ? "?token=" + encodeURIComponent(TOKEN) : "";',
    'const $ = (id) => document.getElementById(id);',
    'async function api(path, opts) {',
    '  const res = await fetch(path + qs, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));',
    '  let data = null; try { data = await res.json(); } catch (e) { data = null; }',
    '  if (!res.ok) throw new Error((data && (data.error || data.message)) || ("HTTP " + res.status));',
    '  return data || {};',
    '}',
    'function pill(el, text, kind) { el.textContent = text; el.className = "pill" + (kind ? " " + kind : ""); }',
    'let qrTimer = null;',
    'async function refreshStatus() {',
    '  try {',
    '    const s = await api("/api/status");',
    '    pill($("conn"), s.connections > 0 ? ("OneBot 已连接 " + s.connections) : "等待 NapCat 连接", s.connections > 0 ? "ok" : "warn");',
    '    var llmText = s.llm.mode === "external"\n'
    + '      ? (s.llm.hasKey ? ("外部模型 " + (s.llm.model || "未填")) : "外部端点未配置密钥")\n'
    + '      : ("Harness 模型 " + (s.llm.model || "跟随当前选择"));\n'
    + '    pill($("llm"), llmText, s.llm.mode === "external" ? (s.llm.hasKey ? "ok" : "warn") : "ok");',
    '    if (s.reverseUrl) $("revurl").textContent = s.reverseUrl;',
    '    if (s.selfIds && s.selfIds.length) pill($("loginState"), "已登录 QQ " + s.selfIds.join(", "), "ok");',
    '  } catch (e) { pill($("conn"), "状态获取失败", "err"); }',
    '}',
    'async function newQr(isRefresh) {',
    '  const btn = isRefresh ? $("btnRefresh") : $("btnQr");',
    '  btn.disabled = true;',
    '  $("qrHint").textContent = "正在向 NapCat 请求二维码…";',
    '  try {',
    '    const r = await api("/api/qr", { method: "POST" });',
    '    if (r.logined) {',
    '      $("qrBox").innerHTML = "<span class=\\"muted\\">该 NapCat 已经登录，无需扫码</span>";',
    '      pill($("loginState"), "已登录" + (r.uin ? (" QQ " + r.uin) : ""), "ok");',
    '      $("qrHint").textContent = "";',
    '    } else {',
    '      $("qrBox").innerHTML = "<img alt=\\"QQ 登录二维码\\" src=\\"/api/qr.svg" + qs + "&t=" + Date.now() + "\\">";',
    '      $("btnRefresh").disabled = false;',
    '      const left = Math.max(0, Math.round((r.qr.expiresAt - Date.now()) / 1000));',
    '      $("qrHint").textContent = "二维码约 " + left + " 秒后失效，到期请点刷新。";',
    '      pill($("loginState"), "等待扫码", "warn");',
    '      startPoll();',
    '    }',
    '  } catch (e) {',
    '    $("qrBox").innerHTML = "<span class=\\"muted\\">" + e.message + "</span>";',
    '    $("qrHint").textContent = "请确认 NapCat 已启动、WebUI 端口正确，且 napcat.webuiToken 与 NapCat 的登录令牌一致。";',
    '    pill($("loginState"), "获取失败", "err");',
    '  } finally { btn.disabled = false; }',
    '}',
    'function startPoll() {',
    '  if (qrTimer) return;',
    '  qrTimer = setInterval(async () => {',
    '    try {',
    '      const info = await api("/api/login-info", { method: "POST" });',
    '      if (info.isLogin) {',
    '        clearInterval(qrTimer); qrTimer = null;',
    '        pill($("loginState"), "已登录" + (info.uin ? (" QQ " + info.uin) : ""), "ok");',
    '        $("qrBox").innerHTML = "<span class=\\"muted\\">登录成功，可以继续第 3 步</span>";',
    '        $("qrHint").textContent = "";',
    '        refreshStatus();',
    '      }',
    '    } catch (e) { /* transient */ }',
    '  }, 3000);',
    '}',
    '$("btnQr").addEventListener("click", () => newQr(false));',
    '$("btnRefresh").addEventListener("click", () => newQr(true));',
    '$("btnLink").addEventListener("click", async () => {',
    '  const btn = $("btnLink"); btn.disabled = true;',
    '  pill($("linkState"), "写入中…");',
    '  try {',
    '    const r = await api("/api/link", { method: "POST" });',
    '    pill($("linkState"), r.added ? "已新增接入" : "已更新接入", "ok");',
    '    setTimeout(refreshStatus, 3000);',
    '  } catch (e) { pill($("linkState"), "接入失败: " + e.message, "err"); }',
    '  finally { btn.disabled = false; }',
    '});',
    'refreshStatus();',
    'setInterval(refreshStatus, 5000);',
    '</script>',
    '</body>',
    '</html>',
  ].join('\n');
}
