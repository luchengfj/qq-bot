// Exercises lib/bridge.js end-to-end against a real OneBotBridge + SetupConsole:
// status shape, guard rules, QR handing, link, stats reset, outgoing params.
// Run: node test/bridge_e2e.mjs

import http from 'node:http';
import net from 'node:net';
import { makeBridgeRoutes, createLogRing, createStats, buildOutgoingParams, isBridgeRequestAllowed } from '../lib/bridge.js';
import { OneBotBridge } from '../lib/onebot.js';
import { SetupConsole } from '../lib/setup.js';
import { normalizeConfig } from '../lib/bot.js';

const results = [];
function check(name, cond, extra) {
  const ok = Boolean(cond);
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra ? ' :: ' + extra : ''}`);
}

const QR_URL = 'https://q.qq.com/x/abcdefghijklmnopqrstuvwxyz012345';

// --- fake NapCat WebUI -------------------------------------------------------
const napcatState = { linked: null, logined: false };
const napcat = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const json = (obj) => {
      const s = JSON.stringify(obj);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(s) });
      res.end(s);
    };
    if (req.url === '/api/auth/login') return json({ Credential: Buffer.from('cred-abc').toString('base64') });
    if (req.url === '/api/test') return json({ ok: true });
    if (req.url === '/api/QQLogin/CheckLoginStatus') {
      return json({ isLogin: napcatState.logined, online: napcatState.logined, loginPhase: '', qrcodeurl: '', loginError: '' });
    }
    if (req.url === '/api/QQLogin/GetQQLoginQrcode') return json({ qrcode: QR_URL });
    if (req.url === '/api/QQLogin/GetQQLoginInfo') return json({ uin: '999001', online: napcatState.logined });
    if (req.url === '/api/OB11Config/GetConfig') {
      return json({ network: { websocketClients: [] } });
    }
    if (req.url === '/api/OB11Config/SetConfig') {
      // The client posts the whole config under a `config` key.
      const payload = JSON.parse(body || '{}');
      napcatState.linked = (payload?.config?.network?.websocketClients || [])[0] || null;
      return json({ ok: true });
    }
    res.writeHead(404); res.end('nope');
  });
});
await new Promise((r) => napcat.listen(0, '127.0.0.1', r));
const napcatPort = napcat.address().port;

// --- plugin bridge under test ------------------------------------------------
const port = 6700 + Math.floor(Math.random() * 400);
const cfg = normalizeConfig({
  host: '127.0.0.1',
  port,
  path: '/onebot',
  accessToken: 'tok-123',
  napcat: { enabled: true, baseUrl: `http://127.0.0.1:${napcatPort}`, webuiToken: 'napcat-token', reverseHost: '127.0.0.1', reversePort: port, timeoutMs: 20000 },
  llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', model: 'test-model', timeoutMs: 5000 },
});
const logRing = createLogRing(10);
const stats = createStats();
const logs = [];
const log = (m) => { logs.push(String(m)); logRing.push(m); };

const bridge = new OneBotBridge(cfg);
await bridge.start();
const setup = new SetupConsole(cfg, bridge, log);

const routes = makeBridgeRoutes({ cfg, bridge, setup, log, logRing, stats });

// A bare server that mimics ctx.webServer: routes registered here, so requests
// arrive with a loopback remoteAddress, exactly like the real Web UI.
const routeMap = new Map();
for (const route of routes) routeMap.set(route.path, route);
const panel = http.createServer((req, res) => {
  const path = req.url.split('?')[0];
  const route = routeMap.get(path);
  if (!route) { res.writeHead(404); res.end('no route'); return; }
  route.handler(req, res).catch((err) => { res.writeHead(500); res.end(err.message); });
});
await new Promise((r) => panel.listen(0, '127.0.0.1', r));
const panelPort = panel.address().port;

const req = async (path, options = {}) => {
  const res = await fetch(`http://127.0.0.1:${panelPort}${path}`, options);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { data = null; }
  return { status: res.status, data, text, headers: res.headers };
};

// --- 1. status shape ---------------------------------------------------------
log('hello');
stats.received = 3; stats.answered = 2; stats.failed = 1; stats.lastError = 'boom'; stats.lastAt = Date.now();
{
  const r = await req('/api/qq-bot/status');
  check('GET /status -> 200', r.status === 200, `status=${r.status}`);
  const s = r.data || {};
  check('status.plugin', s.plugin === '@local/qq-bot', String(s.plugin));
  check('status.started', s.started === true, String(s.started));
  check('status.endpoint', s.endpoint && s.endpoint.port === port, JSON.stringify(s.endpoint));
  check('status.reverseUrl contains port', String(s.reverseUrl).includes(String(port)), String(s.reverseUrl));
  check('status.reverseUrl carries token', String(s.reverseUrl).includes('access_token=tok-123'), String(s.reverseUrl));
  check('status.napcat.hasToken', s.napcat && s.napcat.hasToken === true, JSON.stringify(s.napcat));
  check('status.llm.hasKey', s.llm && s.llm.hasKey === true, JSON.stringify(s.llm));
  check('status.stats', s.stats && s.stats.received === 3 && s.stats.answered === 2 && s.stats.failed === 1, JSON.stringify(s.stats));
  check('status.log carries ring', Array.isArray(s.log) && s.log.length === 1 && s.log[0].message === 'hello', JSON.stringify(s.log));
}

// --- 2. guard rules ----------------------------------------------------------
{
  const bad = [
    { name: 'cross-site sec-fetch', headers: { host: `127.0.0.1:${panelPort}`, 'sec-fetch-site': 'cross-site' } },
    { name: 'foreign origin', headers: { host: `127.0.0.1:${panelPort}`, origin: 'http://evil.example' } },
  ];
  for (const b of bad) {
    const res = await fetch(`http://127.0.0.1:${panelPort}/api/qq-bot/status`, { headers: b.headers });
    check(`guard rejects ${b.name}`, res.status === 403, `status=${res.status}`);
  }
  // fetch() refuses to let us set Host (it's a forbidden header), so drive the
  // non-loopback case through a raw socket instead.
  const raw = await new Promise((resolve) => {
    const socket = net.connect(panelPort, '127.0.0.1', () => {
      socket.write(`GET /api/qq-bot/status HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n`);
    });
    let buf = '';
    socket.on('data', (d) => { buf += d.toString(); });
    socket.on('end', () => resolve(buf));
    socket.on('error', () => resolve(''));
  });
  check('guard rejects non-loopback host', raw.includes('403'), raw.split('\r\n')[0] || 'no response');
  const wrongMethod = await req('/api/qq-bot/qr');
  check('guard rejects GET on POST route', wrongMethod.status === 405, `status=${wrongMethod.status}`);
}

// --- 3. qr flow --------------------------------------------------------------
{
  const r = await req('/api/qq-bot/qr', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /qr -> 200', r.status === 200, JSON.stringify(r.data));
  check('POST /qr returns url', r.data && r.data.qr && r.data.qr.url === QR_URL, JSON.stringify(r.data));
  const svg = await req('/api/qq-bot/qr.svg');
  check('GET /qr.svg -> svg', svg.status === 200 && String(svg.headers.get('content-type')).includes('svg') && svg.text.includes('<svg'), `status=${svg.status}`);
  check('qr cached on setup', Boolean(setup.qr && setup.qr.svg), 'none');
}

// --- 4. login-info -----------------------------------------------------------
{
  napcatState.logined = true;
  const r = await req('/api/qq-bot/login-info', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /login-info isLogin', r.status === 200 && r.data && r.data.isLogin === true, JSON.stringify(r.data));
  const r2 = await req('/api/qq-bot/qr', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /qr says logined when online', r2.data && r2.data.logined === true, JSON.stringify(r2.data));
  napcatState.logined = false;
}

// --- 5. link -----------------------------------------------------------------
{
  const r = await req('/api/qq-bot/link', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /link -> 200', r.status === 200 && r.data && r.data.ok === true, JSON.stringify(r.data));
  check('POST /link wrote ws client', Boolean(napcatState.linked && napcatState.linked.enable === true), JSON.stringify(napcatState.linked));
  check('POST /link url matches reverseUrl', napcatState.linked && napcatState.linked.url === setup.reverseUrl(), String(napcatState.linked && napcatState.linked.url));
  check('POST /link token', napcatState.linked && napcatState.linked.token === 'tok-123', String(napcatState.linked && napcatState.linked.token));
  check('POST /link logged', logs.some((l) => String(l).includes('已写入 NapCat 反向 WebSocket')), 'no log');
}

// --- 6. stats reset + log clear ----------------------------------------------
{
  await req('/api/qq-bot/stats-reset', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('stats reset', stats.received === 0 && stats.answered === 0 && stats.failed === 0, JSON.stringify({ r: stats.received, a: stats.answered, f: stats.failed }));
  await req('/api/qq-bot/log-clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('log cleared', logRing.list().length === 0, String(logRing.list().length));
}

// --- 7. send params ----------------------------------------------------------
{
  check('outgoing private', JSON.stringify(buildOutgoingParams({ messageType: 'private', userId: '42', text: 'hi' })) === JSON.stringify({ message_type: 'private', user_id: 42, message: 'hi' }), JSON.stringify(buildOutgoingParams({ messageType: 'private', userId: '42', text: 'hi' })));
  check('outgoing group', JSON.stringify(buildOutgoingParams({ message_type: 'group', group_id: '7', message: 'yo' })) === JSON.stringify({ message_type: 'group', group_id: 7, message: 'yo' }), JSON.stringify(buildOutgoingParams({ message_type: 'group', group_id: '7', message: 'yo' })));
  check('outgoing rejects missing id', buildOutgoingParams({ messageType: 'private', text: 'hi' }) === null, 'not null');
  check('outgoing rejects empty text', buildOutgoingParams({ messageType: 'group', groupId: '7', text: '   ' }) === null, 'not null');
  const r = await req('/api/qq-bot/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messageType: 'group', groupId: '7', text: 'hi' }) });
  check('send without connection -> 502', r.status === 502 && r.data && r.data.ok === false, `status=${r.status} ${JSON.stringify(r.data)}`);
  const bad = await req('/api/qq-bot/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: 'not json' });
  check('send rejects non-json body', bad.status === 400 && bad.data && bad.data.ok === false, `status=${bad.status}`);
}

// --- 8. llm-test fails gracefully -------------------------------------------
{
  const r = await req('/api/qq-bot/llm-test', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('llm-test returns ok:false on unreachable model', r.status === 200 && r.data && r.data.ok === false, JSON.stringify(r.data));
}

// --- 9. guard unit checks ----------------------------------------------------
{
  check('guard: no host rejected', isBridgeRequestAllowed({ headers: {}, socket: {} }) === false, 'allowed');
  check('guard: malformed host rejected', isBridgeRequestAllowed({ headers: { host: 'not a host' }, socket: { remoteAddress: '127.0.0.1' } }) === false, 'allowed');
  check('guard: loopback ok', isBridgeRequestAllowed({ headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '127.0.0.1' } }) === true, 'rejected');
  check('guard: localhost ok', isBridgeRequestAllowed({ headers: { host: 'localhost:1234' }, socket: { remoteAddress: '::1' } }) === true, 'rejected');
  check('guard: remote peer rejected', isBridgeRequestAllowed({ headers: { host: '127.0.0.1:1234' }, socket: { remoteAddress: '203.0.113.9' } }) === false, 'allowed');
}

// --- teardown ----------------------------------------------------------------
await bridge.stop();
panel.close();
napcat.close();

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAILED ${failed.length}/${results.length}` : `\nALL_BRIDGE_PASS ${results.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
