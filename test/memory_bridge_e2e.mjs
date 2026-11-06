// Bridge-level tests for the memory endpoints (/api/qq-bot/memory*).
// Run: node test/memory_bridge_e2e.mjs

import http from 'node:http';
import { makeBridgeRoutes, createLogRing, createStats } from '../lib/bridge.js';
import { ConversationMemory } from '../lib/memory.js';
import { OneBotBridge } from '../lib/onebot.js';

let pass = 0;
let fail = 0;
function check(name, cond, extra) {
  if (cond) { pass += 1; console.log(`✓ ${name}`); }
  else { fail += 1; console.log(`✗ ${name}${extra !== undefined ? ` — ${JSON.stringify(extra)}` : ''}`); }
}

const pick = (lo, hi) => lo + Math.floor(Math.random() * (hi - lo));

const cfg = {
  host: '127.0.0.1', port: 6700, path: '/onebot', accessToken: '', secret: '',
  replyVia: 'ws', httpApiBase: '', httpApiToken: '', replyAtSender: true,
  maxImageBytes: 1024,
  llm: { baseUrl: 'http://127.0.0.1:1/v1', apiKey: '', model: 'm', maxReplyChars: 0 },
};

const bridge = new OneBotBridge(cfg);
const memory = new ConversationMemory({ enabled: true, maxFacts: 10 });
memory.remember('private:42', '我叫小明');
memory.remember('private:42', '我住在杭州');
memory.remember('group:9:42', '我在群里说过的话');

const routes = makeBridgeRoutes({
  cfg, bridge, log: () => {}, logRing: createLogRing(10), stats: createStats(), memory,
});

// 17 routes in zero-download mode: status, diagnose, log, chat, chat-clear,
// forward-config, forward-disconnect, llm-test, send, stats-reset, log-clear
// and the six memory/* endpoints. (NapCat QR/link/install/launch are gone.)
check('route count is 17 in zero-download mode', routes.length === 17, routes.length);
const paths = routes.map((r) => r.path);
for (const p of ['/api/qq-bot/chat', '/api/qq-bot/chat-clear', '/api/qq-bot/forward-config', '/api/qq-bot/forward-disconnect', '/api/qq-bot/diagnose']) {
  check(`zero-download route ${p}`, paths.indexOf(p) >= 0, paths);
}
for (const p of ['/api/qq-bot/qr', '/api/qq-bot/link', '/api/qq-bot/napcat-install', '/api/qq-bot/napcat-launch']) {
  check(`NapCat route ${p} is gone`, paths.indexOf(p) < 0, paths);
}
for (const p of ['/api/qq-bot/memory', '/api/qq-bot/memory-facts', '/api/qq-bot/memory-forget', '/api/qq-bot/memory-save', '/api/qq-bot/memory-history', '/api/qq-bot/memory-newtopic']) {
  check(`route ${p}`, paths.indexOf(p) >= 0, paths);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => r.path === url.pathname);
  if (!route) { res.writeHead(404); res.end('{}'); return; }
  route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: await res.json() };
};
const post = async (p, body) => {
  const res = await fetch(base + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
};

// /status now carries memory stats
const st = await get('/api/qq-bot/status');
check('status includes memory', st.body.memory && st.body.memory.senders === 2, st.body.memory);

// /memory
const mem = await get('/api/qq-bot/memory');
check('memory returns stats', mem.body.enabled === true && mem.body.facts === 3, mem.body);
check('memory lists senders', Array.isArray(mem.body.senders) && mem.body.senders.length === 2, mem.body.senders);
check('sender rows have preview', mem.body.senders.every((s) => typeof s.preview === 'string'));

// /memory-facts
const f1 = await get('/api/qq-bot/memory-facts?key=' + encodeURIComponent('private:42'));
check('facts for private:42', f1.body.facts.length === 2, f1.body);
check('facts content', f1.body.facts.some((x) => x.indexOf('小明') >= 0), f1.body.facts);

const f2 = await get('/api/qq-bot/memory-facts?key=' + encodeURIComponent('group:9:42'));
check('group facts isolated', f2.body.facts.length === 1, f2.body.facts);

const f3 = await get('/api/qq-bot/memory-facts');
check('missing key returns empty', f3.body.facts.length === 0, f3.body);

// /memory-forget single fact
const del = await post('/api/qq-bot/memory-forget', { key: 'private:42', fact: '杭州' });
check('forget one fact', del.body.ok === true && del.body.removed === 1, del.body);
check('fact gone', memory.facts('private:42').length === 1, memory.facts('private:42'));

// /memory-forget whole sender
const del2 = await post('/api/qq-bot/memory-forget', { key: 'private:42' });
check('forget sender', del2.body.ok === true && del2.body.removed === 1, del2.body);
check('sender gone', memory.facts('private:42').length === 0);

// /memory-forget all
const del3 = await post('/api/qq-bot/memory-forget', { scope: 'all' });
check('forget all', del3.body.ok === true && del3.body.cleared >= 1, del3.body);
check('everything gone', memory.stats().facts === 0, memory.stats());

// missing key
const bad = await post('/api/qq-bot/memory-forget', { scope: 'sender' });
check('missing key rejected', bad.status === 400 && bad.body.ok === false, bad.body);

// /memory-save without a file still succeeds (no-op)
const sv = await post('/api/qq-bot/memory-save', {});
check('save without file is ok', sv.body.ok === true, sv.body);

// ------------------------------------------------- conversation history API
memory.addTurn('private:42', '第一个问题', '第一个回答');
memory.addTurn('private:42', '第二个问题', '第二个回答');

const h1 = await get('/api/qq-bot/memory-history?key=private%3A42');
check('history returns turns', h1.body.ok === true && h1.body.turns.length === 2, h1.body);
check('history content', h1.body.turns[1].user === '第二个问题', h1.body.turns);

const h2 = await get('/api/qq-bot/memory-history?key=private%3A99');
check('history of unknown key is empty', h2.body.ok === true && h2.body.turns.length === 0, h2.body);

const h3 = await get('/api/qq-bot/memory-history');
check('history without key is empty', h3.body.ok === true && h3.body.turns.length === 0, h3.body);

// /memory-newtopic clears the window but keeps the long-term facts
memory.remember('private:42', '我叫小明');
const nt = await post('/api/qq-bot/memory-newtopic', { key: 'private:42' });
check('newtopic resets', nt.body.ok === true && nt.body.reset === true, nt.body);
check('newtopic cleared turns', memory.history('private:42').length === 0, memory.history('private:42'));
check('newtopic kept facts', memory.facts('private:42').length === 1, memory.facts('private:42'));

const nt2 = await post('/api/qq-bot/memory-newtopic', { key: 'private:42' });
check('newtopic again is a no-op', nt2.body.ok === true && nt2.body.reset === false, nt2.body);

const nt3 = await post('/api/qq-bot/memory-newtopic', {});
check('newtopic without key rejected', nt3.status === 400 && nt3.body.ok === false, nt3.body);

server.close();
console.log(`\n${fail === 0 ? 'ALL_MEMORY_BRIDGE_PASS' : 'MEMORY_BRIDGE_FAILURES'} ${pass}/${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
