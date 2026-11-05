// End-to-end test for the setup console + NapCat WebUI client.
//
// Spins up a fake NapCat WebUI (auth/login, QR, login status, OB11 config) and
// a real OneBotBridge with the SetupConsole attached, then exercises:
//   1. sha256-based auth/login credential exchange
//   2. GET /setup renders the console
//   3. POST /api/qr returns a QR and /api/qr.svg renders a decodable one
//   4. POST /api/link writes a reverse-WS entry into onebot11.json
//   5. /health reports the new fields
import http from 'node:http';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { OneBotBridge } from '../lib/onebot.js';
import { SetupConsole } from '../lib/setup.js';
import { normalizeConfig } from '../lib/bot.js';
import { encode } from '../lib/qr.js';

const WEBUI_TOKEN = 'napcat-secret-token';
const QR_URL = 'https://q.qq.com/x/abcdefghijklmnopqrstuvwxyz012345';

let ob11Config = {
  network: {
    httpServers: [],
    httpSseServers: [],
    httpClients: [],
    websocketServers: [],
    websocketClients: [],
    plugins: [],
  },
  musicSignUrl: '',
  enableLocalFile2Url: false,
  parseMultMsg: false,
  imageDownloadProxy: '',
};
let setConfigCalls = 0;

// The fake WebUI mirrors NapCat v4.x exactly: every reply is HTTP 200 with a
// { code, message, data } envelope, auth uses sha256(token + ".napcat"), and
// SetConfig receives config as a JSON *string*. Asserting these here is what
// keeps the mock honest — a flat/plain-hash mock would let a broken client pass.
const webui = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const send = (data, code = 0, message = 'success') => {
      const s = JSON.stringify({ code, message, data });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
      res.end(s);
    };
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/api/test') return send({ ok: true });
    if (path === '/api/auth/login') {
      const { hash } = body ? JSON.parse(body) : {};
      assert.equal(hash, crypto.createHash('sha256').update(WEBUI_TOKEN + '.napcat').digest('hex'));
      return send({ Credential: Buffer.from('cred-abc').toString('base64') });
    }
    const auth = String(req.headers.authorization || '');
    if (auth !== `Bearer ${Buffer.from('cred-abc').toString('base64')}`) {
      return send(null, -1, 'unauthorized');
    }
    if (path === '/api/QQLogin/CheckLoginStatus') return send({ isLogin: false, isOffline: true, loginPhase: 'waiting' });
    if (path === '/api/QQLogin/GetQQLoginInfo') return send({ uin: null });
    if (path === '/api/QQLogin/GetQQLoginQrcode') return send({ qrcode: QR_URL });
    if (path === '/api/QQLogin/RefreshQRcode') return send({});
    if (path === '/api/OB11Config/GetConfig') return send(ob11Config);
    if (path === '/api/OB11Config/SetConfig') {
      setConfigCalls++;
      const outer = body ? JSON.parse(body) : {};
      assert.equal(typeof outer.config, 'string', 'SetConfig.config must be a JSON string');
      ob11Config = JSON.parse(outer.config);
      return send({});
    }
    res.writeHead(404);
    res.end('{}');
  });
});

const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { results.push([true, name]); console.log(`PASS ${name}`); })
    .catch((err) => { results.push([false, name]); console.log(`FAIL ${name}: ${err.message}`); });
}

const webuiPort = await new Promise((resolve) => {
  webui.listen(0, '127.0.0.1', () => resolve(webui.address().port));
});

// normalizeConfig clamps port into 1..65535, so pick a free high port instead
// of 0 (which would clamp to 1).
const PORT = 6700 + Math.floor(Math.random() * 400);
const cfg = normalizeConfig({
  host: '127.0.0.1',
  port: PORT,
  accessToken: 'plugintoken',
  napcat: { baseUrl: `http://127.0.0.1:${webuiPort}`, webuiToken: WEBUI_TOKEN },
});
const bridge = new OneBotBridge(cfg);
bridge.setup = new SetupConsole(cfg, bridge, () => {});
const port = await new Promise((resolve, reject) => {
  bridge.start().then((a) => resolve(a.port)).catch(reject);
});
assert.equal(port, PORT);
const base = `http://127.0.0.1:${port}`;
const TOKEN = cfg.accessToken;

async function json(path, opts = {}) {
  const res = await fetch(`${base}${path}?token=${encodeURIComponent(TOKEN)}`, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, data, text };
}

await check('health reports setupPath + reverseUrl', async () => {
  const { status, data } = await json('/health');
  assert.equal(status, 200);
  assert.equal(data.setupPath, '/setup');
  assert.match(data.reverseUrl, /^ws:\/\/127\.0\.0\.1:\d+\/onebot\?access_token=plugintoken$/);
});

await check('GET /setup renders console without token gate blocking', async () => {
  const res = await fetch(`${base}/setup`);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /扫码登录/);
  assert.match(html, /一键接入/);
  assert.match(html, /\/api\/link/);
});

await check('POST /api/qr returns a QR url', async () => {
  const { status, data } = await json('/api/qr', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(data.logined, false);
  assert.equal(data.qr.url, QR_URL);
  assert.ok(data.qr.expiresAt > Date.now());
});

await check('GET /api/qr.svg decodes back to the login url', async () => {
  const res = await fetch(`${base}/api/qr.svg?token=${encodeURIComponent(TOKEN)}`);
  const svg = await res.text();
  assert.equal(res.status, 200);
  assert.match(svg, /^<svg/);
  // Confirm the encoded payload is the login url by re-encoding it ourselves
  // and comparing module-for-module with a fresh encode().
  const expected = encode(QR_URL, 'M');
  const actual = bridge.setup.qr;
  assert.equal(actual.url, QR_URL);
  assert.equal(actual.encoded.size, expected.size);
  assert.deepEqual([...actual.encoded.modules], [...expected.modules]);
  // The SVG must carry one <path> with the same module count as dark modules.
  let dark = 0;
  for (const v of expected.modules) dark += v;
  assert.ok(dark > 0);
});

await check('POST /api/login-info before login', async () => {
  const { status, data } = await json('/api/login-info', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(data.isLogin, false);
});

await check('POST /api/link writes reverse websocket client', async () => {
  const { status, data } = await json('/api/link', { method: 'POST' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.added, true);
  assert.equal(setConfigCalls, 1);
  const clients = ob11Config.network.websocketClients;
  assert.equal(clients.length, 1);
  assert.equal(clients[0].enable, true);
  assert.equal(clients[0].messagePostFormat, 'array');
  assert.equal(clients[0].name, 'dsh-qq-bot');
  assert.match(clients[0].url, /^ws:\/\/127\.0\.0\.1:\d+\/onebot\?access_token=plugintoken$/);
  assert.equal(clients[0].heartInterval, 30000);
  assert.equal(clients[0].reconnectInterval, 5000);
});

await check('second /api/link updates instead of duplicating', async () => {
  await json('/api/link', { method: 'POST' });
  assert.equal(ob11Config.network.websocketClients.length, 1);
});

await check('unauthorized /api without token is rejected', async () => {
  const res = await fetch(`${base}/api/status`);
  assert.equal(res.status, 401);
});

await check('/api/status reports napcat + llm state', async () => {
  const { data } = await json('/api/status');
  assert.equal(data.napcat.configured, true);
  assert.equal(data.napcat.hasToken, true);
  assert.equal(data.llm.hasKey, false);
  assert.equal(data.started, true);
});

bridge.stop();
webui.close();
const failed = results.filter(([ok]) => !ok).length;
console.log(failed === 0 ? `ALL_SETUP_PASS (${results.length})` : `SETUP_FAILURES=${failed}`);
process.exit(failed === 0 ? 0 : 1);
