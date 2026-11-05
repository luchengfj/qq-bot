// NapCat WebUI client — powers "扫码登录" and "一键接入".
//
// NapCat v4.x (verified against tag v4.18.42) exposes its login/QR/config
// surface as a plain HTTP API on its WebUI port (6099 by default). Two details
// of the protocol are easy to get wrong and were the reason QR/login/link all
// failed silently in earlier builds:
//
//   * Response envelope: EVERY reply is HTTP 200 with
//     { code: 0|-1, message, data }. Errors are NOT signalled by HTTP status —
//     the client must inspect `code` and surface `message`.
//   * Auth hash: the server compares against sha256(token + ".napcat"), NOT
//     sha256(token). A plain hash yields `token is invalid`.
//   * OB11Config/SetConfig wants req.body.config to be a JSON *string*
//     (json5.parse(req.body.config)), not an object.
//
// Routes (all POST, all except /auth/login need Authorization: Bearer):
//   /api/auth/login                  { hash }            -> data.Credential
//   /api/QQLogin/GetQQLoginQrcode   -/> data.qrcode
//   /api/QQLogin/CheckLoginStatus   -/> data.{isLogin,isOffline,loginPhase}
//   /api/QQLogin/GetQQLoginInfo     -/> data.{uin,...}
//   /api/QQLogin/RefreshQRcode      -/> data.qrcodeurl
//   /api/OB11Config/GetConfig       -/> data (parsed onebot11.json)
//   /api/OB11Config/SetConfig       { config: "<json>" }
//
// Only Node built-ins are used. Flat (non-enveloped) responses are still
// accepted so older/3rd-party WebUI builds and test doubles keep working.

import crypto from 'node:crypto';

const DEFAULT_TIMEOUT_MS = 15000;

// Upstream sendError() literals we can translate into actionable Chinese.
const FRIENDLY_ERRORS = {
  'Not Login': 'NapCat 提示：QQ 尚未登录。请先用手机 QQ 扫描二维码并确认登录，然后再点「一键接入」。',
  'token is invalid': 'NapCat WebUI 令牌不正确：请核对 napcat.webuiToken（或让插件从 webui.json 自动发现）。',
  'QRCode Get Error': 'NapCat 暂时无法生成二维码，请稍后刷新，或重启 NapCat 后再试。',
  'QQ Is Logined': 'QQ 已经登录，无需再扫二维码，可直接点「一键接入」。',
};

function friendlyMessage(message) {
  const raw = String(message || '').trim();
  if (FRIENDLY_ERRORS[raw]) return FRIENDLY_ERRORS[raw];
  return raw || 'NapCat 返回了未知错误';
}

function trimTrailingSlash(value) {
  let s = String(value);
  while (s.endsWith('/')) s = s.slice(0, -1);
  return s;
}

export class NapCatClient {
  /**
   * @param {{baseUrl?:string, token?:string, timeoutMs?:number, tokenSource?:string}} [opts]
   */
  constructor(opts = {}) {
    this.baseUrl = trimTrailingSlash(opts.baseUrl || 'http://127.0.0.1:6099');
    this.token = opts.token || '';
    this.tokenSource = opts.tokenSource || (this.token ? 'config' : 'none');
    this.timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.credential = '';
    this.credentialAt = 0;
  }

  get configured() {
    return Boolean(this.baseUrl);
  }

  /** Rebind credentials at runtime (used by auto-discovery). */
  setToken(token, source = 'config') {
    this.token = String(token || '');
    this.tokenSource = source;
    this.credential = '';
    this.credentialAt = 0;
    return this;
  }

  setBaseUrl(url) {
    if (url) this.baseUrl = trimTrailingSlash(url);
    this.credential = '';
    this.credentialAt = 0;
    return this;
  }

  _headers(withAuth = true) {
    const headers = { 'Content-Type': 'application/json' };
    if (withAuth && this.credential) headers.Authorization = `Bearer ${this.credential}`;
    return headers;
  }

  /**
   * POST one API call and return the UNWRAPPED payload.
   *
   * - Unwraps the v4 {code,message,data} envelope (code !== 0 => throw).
   * - Tolerates flat JSON (no `code`) for compatibility.
   * - Re-logins once on 401/403 when the credential has gone stale.
   */
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
      throw new Error(`无法连接 NapCat (${this.baseUrl}${path}): ${reason}。请确认 NapCat 已启动、WebUI 端口 ${this.baseUrl} 可访问。`);
    }

    // The boot credential rotates per process start; a stale one shows up as
    // 401/403 — re-login once with the current token.
    if ((res.status === 401 || res.status === 403) && auth && retryAuth && this.token) {
      await this.login();
      return this._post(path, body, { auth, retryAuth: false });
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(`NapCat 拒绝了请求 (HTTP ${res.status})：WebUI 令牌可能不正确（来源：${this.tokenSource}）`);
    }

    const text = await res.text();
    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { raw: text };
    }

    if (!res.ok) {
      const msg = parsed?.message || parsed?.error || parsed?.raw || `HTTP ${res.status}`;
      throw new Error(`NapCat ${path} 失败: ${friendlyMessage(msg)}`);
    }

    // ---- v4 envelope -----------------------------------------------------
    if (parsed && typeof parsed === 'object' && typeof parsed.code === 'number') {
      if (parsed.code !== 0) {
        throw new Error(`NapCat ${path}: ${friendlyMessage(parsed.message)}`);
      }
      const payload = parsed.data;
      // Keep a couple of well-known nested fallbacks for odd builds.
      if (payload && typeof payload === 'object') return payload;
      return payload === undefined ? {} : payload;
    }

    // ---- legacy / flat JSON ---------------------------------------------
    if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'string') {
      throw new Error(`NapCat ${path} 返回错误: ${friendlyMessage(parsed.error)}`);
    }
    return parsed;
  }

  /** Hash variants: v4 uses the salted one; some older builds use plain. */
  _hashVariants() {
    const salted = crypto.createHash('sha256').update(String(this.token) + '.napcat', 'utf8').digest('hex');
    const plain = crypto.createHash('sha256').update(String(this.token), 'utf8').digest('hex');
    return salted === plain ? [salted] : [salted, plain];
  }

  /** Exchange the webui token for a bearer credential. */
  async login() {
    if (!this.token) {
      throw new Error('未配置 NapCat WebUI 令牌：请在 cordis.patch.yml 填 napcat.webuiToken，或启动 NapCat 让插件从 webui.json 自动发现。');
    }
    const variants = this._hashVariants();
    let lastErr = null;
    for (let i = 0; i < variants.length; i++) {
      try {
        const data = await this._post('/api/auth/login', { hash: variants[i] }, { auth: false, retryAuth: false });
        const cred = data?.Credential || data?.credential;
        if (!cred) {
          if (data?.require2FA) throw new Error('NapCat WebUI 开启了双因素认证，请关闭后再试');
          throw new Error('NapCat 未返回登录凭据，请检查 webuiToken');
        }
        this.credential = cred;
        this.credentialAt = Date.now();
        return cred;
      } catch (err) {
        lastErr = err;
        // Only fall back to the plain hash when the salted one was rejected as
        // an invalid token — otherwise surface the real error immediately.
        const retryable = i === 0 && variants.length > 1 && /token is invalid|令牌不正确|401|403/i.test(err.message);
        if (!retryable) throw err;
      }
    }
    throw lastErr || new Error('NapCat 登录失败');
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
    // Envelope already unwrapped by _post; flat mocks may still wrap in .config.
    if (data && typeof data === 'object' && data.config && typeof data.config === 'object' && data.config.network) {
      return data.config;
    }
    return data?.data || data;
  }

  async setOb11Config(config) {
    await this.ensureLogin();
    // Upstream does json5.parse(req.body.config), so the value MUST be a JSON
    // string, not an object (see api/OB11Config.ts / controllers/qq_manager.ts).
    return this._post('/api/OB11Config/SetConfig', { config: JSON.stringify(config) });
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
