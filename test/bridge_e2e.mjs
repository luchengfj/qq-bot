// Exercises lib/bridge.js end-to-end in ZERO-DOWNLOAD mode against a real
// OneBotBridge + ChatSimulator + ForwardManager: status shape, guard rules,
// chat, forward config, stats reset, outgoing params, llm-test and diagnose.
// Run: node test/bridge_e2e.mjs

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import { makeBridgeRoutes, createLogRing, createStats, buildOutgoingParams, isBridgeRequestAllowed } from '../lib/bridge.js';
import { OneBotBridge } from '../lib/onebot.js';
import { ChatSimulator } from '../lib/simulator.js';
import { ForwardManager } from '../lib/forward.js';
import { normalizeConfig } from '../lib/bot.js';

const results = [];
function check(name, cond, extra) {
  const ok = Boolean(cond);
  results.push({ name, ok, extra });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${!ok && extra ? ' :: ' + extra : ''}`);
}

// --- plugin bridge under test ------------------------------------------------
const port = 6700 + Math.floor(Math.random() * 400);
const cfg = normalizeConfig({
  host: '127.0.0.1',
  port,
  path: '/onebot',
  accessToken: 'tok-123',
  forward: { enabled: false, url: '', accessToken: '', reconnectMs: 5000 },
  llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: 'sk-test', model: 'test-model', timeoutMs: 5000 },
});
const logRing = createLogRing(10);
const stats = createStats();
const logs = [];
const log = (m) => { logs.push(String(m)); logRing.push(m); };

const bridge = new OneBotBridge(cfg);
await bridge.start();

// A stub "logic" that records the event and replies through replyFn, so the
// /chat route exercises the REAL ChatSimulator -> BotLogic.handle contract
// without needing a model endpoint.
const seen = [];
const stubLogic = {
  memory: { clearHistory() {}, stats() { return { facts: 0, senders: 0 }; } },
  async handle(event, replyFn) {
    seen.push({ event, context: arguments[2] });
    await replyFn('面板测试回复');
    return { ok: true };
  },
};
const simulator = new ChatSimulator(stubLogic, log, { memory: stubLogic.memory });
const STORE_PATH = 'qq-bot/test/_bridge_forward_store.json';
const forward = new ForwardManager(bridge, log, { storePath: STORE_PATH });
forward.init(cfg.forward);

const routes = makeBridgeRoutes({ cfg, bridge, log, logRing, stats, simulator, forward, memory: stubLogic.memory });

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
  check('status.endpoint.reverseWsUrl contains port', String(s.endpoint && s.endpoint.reverseWsUrl).includes(String(port)), JSON.stringify(s.endpoint));
  check('status.mode standalone', s.mode === 'standalone', String(s.mode));
  check('status.forward.enabled false', s.forward && s.forward.enabled === false, JSON.stringify(s.forward));
  check('status.forward.status idle', s.forward && s.forward.status === 'idle', JSON.stringify(s.forward));
  check('status.llm.hasKey', s.llm && s.llm.hasKey === true, JSON.stringify(s.llm));
  check('status.stats', s.stats && s.stats.received === 3 && s.stats.answered === 2 && s.stats.failed === 1, JSON.stringify(s.stats));
  check('status.log carries ring', Array.isArray(s.log) && s.log.some((entry) => entry && entry.message === 'hello'), JSON.stringify(s.log));
  check('status.chat.messages is array', s.chat && Array.isArray(s.chat.messages), JSON.stringify(s.chat));
  check('status.reverseUrl is GONE (zero-download)', s.reverseUrl === undefined, JSON.stringify(Object.keys(s)));
  check('status.napcat is GONE (zero-download)', s.napcat === undefined, JSON.stringify(Object.keys(s)));
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
  const wrongMethod = await req('/api/qq-bot/chat');
  check('guard rejects GET on POST route', wrongMethod.status === 405, `status=${wrongMethod.status}`);
}

// --- 3. chat (the zero-download headline feature) ----------------------------
{
  const r = await req('/api/qq-bot/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '你好' }) });
  check('POST /chat -> 200', r.status === 200, JSON.stringify(r.data));
  check('POST /chat ok + reply', r.data && r.data.ok === true && r.data.replies.some((m) => String(m).includes('面板测试回复')), JSON.stringify(r.data));
  check('POST /chat returns transcript history', r.data && Array.isArray(r.data.history) && r.data.history.length >= 2, JSON.stringify(r.data && r.data.history));
  check('stub logic saw a OneBot v11 private event', seen.length === 1 && seen[0].event.post_type === 'message' && seen[0].event.message_type === 'private' && seen[0].event.user_id === 10001, JSON.stringify(seen[0] && seen[0].event));
  check('stub logic saw context.hint (panel chat)', seen[0] && seen[0].context && String(seen[0].context.hint).includes('面板'), JSON.stringify(seen[0] && seen[0].context));
  const empty = await req('/api/qq-bot/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: '' }) });
  check('POST /chat rejects empty text', empty.status === 200 && empty.data && empty.data.ok === false, JSON.stringify(empty.data));
  const after = await req('/api/qq-bot/status');
  check('status.chat.messages reflects chat', after.data && after.data.chat && after.data.chat.messages.length >= 2, JSON.stringify(after.data && after.data.chat));
  const cleared = await req('/api/qq-bot/chat-clear', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /chat-clear empties transcript', cleared.status === 200 && cleared.data && cleared.data.ok === true && cleared.data.history.length === 0, JSON.stringify(cleared.data));
}

// --- 4. forward config (real QQ is OPTIONAL and never downloaded) ------------
{
  const bad = await req('/api/qq-bot/forward-config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://bad' }) });
  check('POST /forward-config rejects http://', bad.status === 200 && bad.data && bad.data.ok === false, JSON.stringify(bad.data));
  const off = await req('/api/qq-bot/forward-disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /forward-disconnect -> ok', off.status === 200 && off.data && off.data.ok === true && off.data.forward.connected === false, JSON.stringify(off.data));
  const st = await req('/api/qq-bot/status');
  check('status.forward.disabled after disconnect', st.data && st.data.forward && st.data.forward.enabled === false, JSON.stringify(st.data && st.data.forward));
}

// --- 5. diagnose (6 checks, no NapCat WebUI probes) --------------------------
{
  const r = await req('/api/qq-bot/diagnose', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
  check('POST /diagnose -> 200', r.status === 200, JSON.stringify(r.data));
  check('POST /diagnose has checks array', r.data && Array.isArray(r.data.checks) && r.data.checks.length === 6, JSON.stringify(r.data && r.data.checks));
  check('POST /diagnose has hints', r.data && Array.isArray(r.data.hints), JSON.stringify(r.data && r.data.hints));
  check('POST /diagnose no webui token check', r.data && r.data.checks.every((c) => c.id !== 'token' && c.id !== 'webui'), JSON.stringify(r.data && r.data.checks.map((c) => c.id)));
  check('POST /diagnose standalone hint', r.data && r.data.hints.some((h) => String(h).includes('独立测试')), JSON.stringify(r.data && r.data.hints));
}

// --- 6. stats reset + log clear ---------------------------------------------
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

// --- 10. NapCat routes are gone ---------------------------------------------
{
  for (const p of ['/api/qq-bot/qr', '/api/qq-bot/qr.svg', '/api/qq-bot/login-info', '/api/qq-bot/link', '/api/qq-bot/napcat-install', '/api/qq-bot/napcat-launch']) {
    check(`NapCat route ${p} is gone`, !routeMap.has(p), [...routeMap.keys()]);
  }
}

// --- teardown ----------------------------------------------------------------
forward.dispose();
await bridge.stop();
panel.close();
try { fs.unlinkSync(STORE_PATH); } catch { /* already gone */ }

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\nFAILED ${failed.length}/${results.length}` : `\nALL_BRIDGE_PASS ${results.length}/${results.length}`);
process.exit(failed.length ? 1 : 0);
