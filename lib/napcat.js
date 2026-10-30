// NapCat WebUI client — powers "扫码登录" and "一键接入".
//
// NapCat exposes its login/QR/config surface as a plain HTTP API on its WebUI
// port (6099 by default). Everything here is reverse-engineered from the
// upstream source (packages/napcat-webui-backend/src/router/*) and uses only
// Node built-ins:
//
//   POST /api/auth/login                  { hash: sha256(token) } -> { Credential }
//   POST /api/QQLogin/GetQQLoginQrcode    -> { qrcode: <url> }
//   POST /api/QQLogin/CheckLoginStatus    -> { isLogin, loginPhase, ... }
//   POST /api/QQLogin/GetQQLoginInfo      -> { uin, ... }
//   POST /api/OB11Config/GetConfig        -> <onebot11.json>
//   POST /api/OB11Config/SetConfig        { config } -> ok
//
// All authenticated routes take `Authorization: Bearer <Credential>`.

import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15000;

function trimTrailingSlash(value) {
  let s = String(value);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export class NapCatClient {
  /**
   * @param {{baseUrl?:string, token?:string, timeoutMs?:number}} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = trimTrailingSlash(opts.baseUrl || 'http://127.0.0.1:6099');
    this.token = opts.token || '';
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.credential = '';
    this.credentialAt = 0;
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  _headers(withAuth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuth && this.credential) headers.Authorization = `Bearer ${this.credential}`;
    return headers;
  }

  async _post(path, body, { auth = true, retryAuth = true } = {}) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this._headers(auth),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' ? '请求超时' : err?.message || String(err);
      throw new Error(`无法连接 NapCat (${this.baseUrl}${path}): ${reason}`);
    }

    // The boot token is the only accepted credential, and it rotates per
    // process start, so a stale/blank one shows up as 401/403 — re-login once.
    if ((res.status === 401 || res.status === 403) && auth && retryAuth && this.token) {
      await this.login();
      return this._post(path, body, { auth, retryAuth: false });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`NapCat 拒绝了请求 (HTTP ${res.status})：请检查 webui 令牌是否正确`);
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const msg = data?.message || data?.error || data?.raw || `HTTP ${res.status}`;
      throw new Error(`NapCat ${path} 失败: ${msg}`);
    }
    if (data && typeof data === 'object' && data.error && typeof data.error === 'string') {
      throw new Error(`NapCat ${path} 返回错误: ${data.error}`);
    }
    return data;
  }

  /** Exchange the webui token for a bearer credential. */
  async login() {
    if (!this.token) throw new Error('未配置 NapCat WebUI 令牌 (napcat.webuiToken)');
    const hash = crypto.createHash('sha256').update(this.token, 'utf8').digest('hex');
    const data = await this._post('/api/auth/login', { hash }, { auth: false, retryAuth: false });
    const cred = data?.Credential || data?.credential;
    if (!cred) throw new Error('NapCat 未返回登录凭据，请检查 webuiToken');
    this.credential = cred;
    this.credentialAt = Date.now();
    return cred;
  }

  async ensureLogin() {
    // Credentials are valid for ~1h; refresh a bit before that.
    if (this.credential && Date.now() - this.credentialAt < 50 * 60 * 1000) return;
    await this.login();
  }

  /** GET /api/test — cheap reachability probe that needs no auth. */
  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/api/test`, {
        method: 'GET',
        signal: AbortSignal.timeout(Math.min(this.timeoutMs, 5000)),
      });
      return { ok: res.ok, status: res.status };
    } catch (err) {
      return { ok: false, status: 0, error: err?.message || String(err) };
    }
  }

  /**
   * Fetch the current login state.
   * @returns {Promise<{isLogin:boolean, uin?:string, online?:boolean, loginPhase?:string, raw:object}>}
   */
  async loginInfo() {
    await this.ensureLogin();
    const [status, info] = await Promise.all([
      this._post('/api/QQLogin/CheckLoginStatus', {}).catch(() => ({})),
      this._post('/api/QQLogin/GetQQLoginInfo', {}).catch(() => ({})),
    ]);
    const uin = info?.uin || info?.data?.uin || status?.uin;
    return {
      isLogin: Boolean(status?.isLogin),
      online: status?.isOffline === false || Boolean(status?.isLogin),
      loginPhase: status?.loginPhase,
      loginError: status?.loginError,
      uin: uin == null ? null : String(uin),
      raw: { status, info },
    };
  }

  /**
   * Request a fresh login QR code.
   * @returns {Promise<{url:string, expiresInMs:number}>}
   */
  async getQrcode() {
    await this.ensureLogin();
    const data = await this._post('/api/QQLogin/GetQQLoginQrcode', {});
    const url = data?.qrcode || data?.data?.qrcode || data?.qrcodeurl;
    if (!url) throw new Error('NapCat 未返回二维码地址（可能已经登录）');
    return { url: String(url), expiresInMs: 120000 };
  }

  /** Ask NapCat to regenerate an expired QR without restarting. */
  async refreshQrcode() {
    await this.ensureLogin();
    await this._post('/api/QQLogin/RefreshQRcode', {});
    return this.getQrcode();
  }

  /** The whole onebot11.json, for inspection/merge. */
  async getOb11Config() {
    await this.ensureLogin();
    const data = await this._post('/api/OB11Config/GetConfig', {});
    return data?.config || data?.data || data;
  }

  async setOb11Config(config) {
    await this.ensureLogin();
    return this._post('/api/OB11Config/SetConfig', { config });
  }

  /**
   * "一键接入": make NapCat dial back into this plugin.
   *
   * Adds (or refreshes) a reverse-WebSocket client entry that points at our
   * OneBot endpoint, then writes the whole config back. Existing entries for
   * the same URL are replaced rather than duplicated, and other transports are
   * left untouched.
   *
   * @param {{url:string, token?:string, name?:string}} opts
   * @returns {Promise<{added:boolean, url:string, clients:Array}>}
   */
  async linkReverseWebSocket(opts) {
    const url = String(opts.url || '').trim();
    if (!url) throw new Error('缺少反向 WebSocket 地址');

    const config = await this.getOb11Config();
    if (!config || typeof config !== 'object') throw new Error('无法读取 NapCat 的 OneBot 配置');
    if (!config.network || typeof config.network !== 'object') config.network = {};
    const clients = Array.isArray(config.network.websocketClients) ? config.network.websocketClients : [];

    const idx = clients.findIndex((c) => c && String(c.url || '').trim() === url);
    const entry = {
      name: opts.name || 'dsh-qq-bot',
      enable: true,
      url,
      messagePostFormat: 'array',
      reportSelfMessage: false,
      reconnectInterval: 5000,
      token: opts.token || '',
      debug: false,
      heartInterval: 30000,
    };
    if (idx >= 0) clients[idx] = { ...clients[idx], ...entry };
    else clients.push({ ...entry, ...{ verifyCertificate: true } });
    config.network.websocketClients = clients;

    await this.setOb11Config(config);
    return { added: idx < 0, url, clients };
  }
}

/**
 * Build the reverse-WS URL that a NapCat client should dial, using the
 * plugin's own listen settings.
 */
export function reverseWsUrl(cfg, { host, port, path, token } = {}) {
  const h = host || '127.0.0.1';
  const p = port || cfg?.port || 6700;
  let pth = path || cfg?.path || '/onebot';
  if (!pth.startsWith('/')) pth = `/${pth}`;
  const base = `ws://${h}:${p}${pth}`;
  const t = token ?? cfg?.accessToken ?? '';
  return t ? `${base}?access_token=${encodeURIComponent(t)}` : base;
}
