// Regression tests for the NapCat v4 WebUI protocol in lib/napcat.js.
//
// These are the FOUR bugs that made "无法获取二维码 / 无法接入" happen even when
// NapCat was actually running. The fake WebUI mirrors upstream tag v4.18.42:
//   * auth hash = sha256(token + ".napcat")
//   * every response is HTTP 200 with { code, message, data }
//   * /OB11Config/SetConfig wants config as a JSON *string*
//   * /OB11Config/* returns "Not Login" until QQ is logged in
//
// A flat/plain-hash/object-config mock would let a broken client pass — this
// suite deliberately uses the real protocol so the regression stays caught.

import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { NapCatClient, reverseWsUrl } from '../lib/napcat.js';

const results = [];
async function check(name, fn) {
  try { await fn(); results.push([true, name]); console.log('ok  -', name); }
  catch (err) { results.push([false, name]); console.error('FAIL-', name, '\n   ', err.message); }
}

const TOKEN = 'napcat-secret-token';
const SALTED = crypto.createHash('sha256').update(TOKEN + '.napcat').digest('hex');
const PLAIN = crypto.createHash('sha256').update(TOKEN).digest('hex');
const CRED = Buffer.from('cred-abc').toString('base64');

function startServer(mode, state) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
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
          state.loginHashes.push(hash);
          const wantsSalted = mode !== 'plain-only';
          const good = wantsSalted ? hash === SALTED : hash === PLAIN;
          if (!good) return send(null, -1, 'token is invalid');
          return send({ Credential: CRED });
        }
        const auth = String(req.headers.authorization || '');
        if (auth !== `Bearer ${CRED}`) return send(null, -1, 'unauthorized');
        if (path === '/api/QQLogin/GetQQLoginQrcode') return send({ qrcode: 'https://q.qq.com/x/QRCODE' });
        if (path === '/api/QQLogin/CheckLoginStatus') {
          return send({ isLogin: state.logged, isOffline: false, loginPhase: 'QR' });
        }
        if (path === '/api/QQLogin/GetQQLoginInfo') return send({ uin: 123456 });
        if (path === '/api/OB11Config/GetConfig') {
          if (!state.logged) return send(null, -1, 'Not Login');
          return send(state.ob11);
        }
        if (path === '/api/OB11Config/SetConfig') {
          if (!state.logged) return send(null, -1, 'Not Login');
          const outer = body ? JSON.parse(body) : {};
          state.setConfigType = typeof outer.config;
          // Upstream does json5.parse(req.body.config): must be a string.
          if (state.setConfigType !== 'string') return send(null, -1, 'config must be a string');
          state.ob11 = JSON.parse(outer.config);
          return send(null, 0);
        }
        return send(null, -1, 'unknown path');
      });
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function client(server) {
  const addr = server.address();
  return new NapCatClient({ baseUrl: `http://127.0.0.1:${addr.port}`, token: TOKEN, timeoutMs: 4000 });
}

await check('salted auth hash is what v4 expects (and differs from plain)', () => {
  assert.notEqual(SALTED, PLAIN);
  assert.equal(SALTED.length, 64);
});

{
  const state = { loginHashes: [], logged: false, ob11: { network: { websocketClients: [] } } };
  const server = await startServer('salted', state);
  await check('login() uses sha256(token + ".napcat") — NOT the plain hash', async () => {
    const c = client(server);
    const cred = await c.login();
    assert.equal(cred, CRED);
    assert.equal(state.loginHashes[0], SALTED);
    assert.ok(!state.loginHashes.includes(PLAIN));
  });
  await check('_post unwraps the {code,message,data} envelope', async () => {
    const c = client(server);
    const qr = await c.getQrcode();
    assert.equal(qr.url, 'https://q.qq.com/x/QRCODE');
  });
  await check('loginInfo() reads isLogin/uin from unwrapped data', async () => {
    const c = client(server);
    const info = await c.loginInfo();
    assert.equal(info.isLogin, false);
    assert.equal(info.uin, '123456');
  });
  await check('code !== 0 surfaces the literal message (Not Login -> Chinese hint)', async () => {
    const c = client(server);
    await assert.rejects(() => c.getOb11Config(), /QQ 尚未登录|Not Login/);
  });
  server.close();
}

{
  const state = { loginHashes: [], logged: true, ob11: { network: { websocketClients: [] } } };
  const server = await startServer('salted', state);
  await check('getOb11Config() unwraps data (not data.data)', async () => {
    const c = client(server);
    const cfg = await c.getOb11Config();
    assert.ok(cfg.network);
    assert.ok(Array.isArray(cfg.network.websocketClients));
  });
  await check('setOb11Config() sends config as a JSON STRING', async () => {
    const c = client(server);
    const cfg = await c.getOb11Config();
    cfg.network.websocketClients.push({ url: 'ws://127.0.0.1:6700/onebot', enable: true });
    await c.setOb11Config(cfg);
    assert.equal(state.setConfigType, 'string');
    assert.equal(state.ob11.network.websocketClients.length, 1);
  });
  await check('linkReverseWebSocket() adds one entry without duplicating', async () => {
    // Reset: an earlier check may have seeded the same URL.
    state.ob11 = { network: { websocketClients: [] } };
    const c = client(server);
    const r1 = await c.linkReverseWebSocket({ url: 'ws://127.0.0.1:6700/onebot', token: '' });
    assert.equal(r1.added, true);
    const r2 = await c.linkReverseWebSocket({ url: 'ws://127.0.0.1:6700/onebot', token: '' });
    assert.equal(r2.added, false);
    assert.equal(state.ob11.network.websocketClients.length, 1);
    assert.equal(state.ob11.network.websocketClients[0].messagePostFormat, 'array');
  });
  server.close();
}

{
  // Legacy build that only accepts the PLAIN hash: login() must fall back.
  const state = { loginHashes: [], logged: false, ob11: {} };
  const server = await startServer('plain-only', state);
  await check('plain-hash fallback only on "token is invalid" (older builds)', async () => {
    const c = client(server);
    const cred = await c.login();
    assert.equal(cred, CRED);
    assert.equal(state.loginHashes[0], SALTED);
    assert.equal(state.loginHashes[1], PLAIN);
  });
  server.close();
}

await check('empty token gives an actionable error, not a silent fail', async () => {
  const c = new NapCatClient({ token: '' });
  await assert.rejects(() => c.login(), /未配置|自动发现|webuiToken/);
});

await check('setToken/setBaseUrl rebind and clear cached credential', () => {
  const c = new NapCatClient({ token: 'old', baseUrl: 'http://a:1' });
  c.credential = 'stale';
  c.setToken('new', 'webui.json');
  assert.equal(c.token, 'new');
  assert.equal(c.tokenSource, 'webui.json');
  assert.equal(c.credential, '');
  c.setBaseUrl('http://b:2/');
  assert.equal(c.baseUrl, 'http://b:2');
});

await check('ping() reports reachability without auth', async () => {
  const server = await startServer('salted', { loginHashes: [], logged: false, ob11: {} });
  const c = client(server);
  const p = await c.ping();
  assert.equal(p.ok, true);
  server.close();
  const c2 = new NapCatClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 1000 });
  const p2 = await c2.ping();
  assert.equal(p2.ok, false);
});

await check('reverseWsUrl appends access_token only when set', () => {
  assert.equal(reverseWsUrl({ port: 6700, path: '/onebot' }, {}), 'ws://127.0.0.1:6700/onebot');
  assert.equal(reverseWsUrl({ port: 6700, path: 'onebot', accessToken: 'a b' }, {}),
    'ws://127.0.0.1:6700/onebot?access_token=a%20b');
});

await check('friendlyMessage translates token is invalid', async () => {
  const state = { loginHashes: [], logged: false, ob11: {} };
  const server = await startServer('salted', state);
  const c = new NapCatClient({ baseUrl: `http://127.0.0.1:${server.address().port}`, token: 'WRONG' });
  await assert.rejects(() => c.login(), /令牌不正确|token is invalid/);
  server.close();
});

const failed = results.filter(([ok]) => !ok).length;
console.log(failed === 0 ? `ALL_AUTH_PASS (${results.length})` : `AUTH_FAILURES=${failed}`);
process.exit(failed === 0 ? 0 : 1);
