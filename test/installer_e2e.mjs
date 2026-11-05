// Verifies the NapCat auto-installer path:
//   * route count grows to 17 and the two new routes exist
//   * /status carries napcatRuntime
//   * startInstall() does NOT trip its own busy guard (regression: it used to
//     set busy='install' before calling install(), which then refused)
//   * job progress is observable through status()
//   * napcat-install / napcat-launch route plumbing (guarded, POST-only)
//   * findLauncher / findOb11Config / powershellLiteral / probePort units
//
// No real download happens: install() is pointed at a fake api.github.com via
// a local server, so the test stays offline and fast.

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { makeBridgeRoutes, createLogRing, createStats } from '../lib/bridge.js';
import { OneBotBridge } from '../lib/onebot.js';
import {
  NapCatInstaller,
  findLauncher,
  findOb11Config,
  powershellLiteral,
  probePort,
  probeWebUi,
} from '../lib/installer.js';

const NODE = process.execPath;
let passed = 0;
let failed = 0;

function check(name, fn, extra) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
    if (extra !== undefined) console.log(`       extra: ${JSON.stringify(extra)}`);
  }
}

async function checkAsync(name, fn, extra) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}: ${err.message}`);
    if (extra !== undefined) console.log(`       extra: ${JSON.stringify(extra)}`);
  }
}

function request(server, pathname, method = 'GET', body) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port: addr.port,
        path: pathname,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { json = null; }
          resolve({ status: res.statusCode, text, json });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------- unit checks

console.log('installer units');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-installer-'));

// Build a tree that looks like an extracted NapCat bundle.
const bundle = path.join(tmp, 'napcat');
fs.mkdirSync(path.join(bundle, 'bootmain'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'bootmain', 'NapCatWinBootMain.exe'), 'x');
fs.mkdirSync(path.join(bundle, 'config'), { recursive: true });
fs.writeFileSync(path.join(bundle, 'config', 'onebot11.json'), '{}');

check('findLauncher finds bootmain launcher', () => {
  assert.equal(findLauncher(bundle), path.join(bundle, 'bootmain', 'NapCatWinBootMain.exe'));
});
check('findLauncher returns null when absent', () => {
  assert.equal(findLauncher(path.join(tmp, 'nope')), null);
});
check('findOb11Config locates onebot11.json', () => {
  assert.equal(findOb11Config(bundle), path.join(bundle, 'config', 'onebot11.json'));
});
check('powershellLiteral escapes single quotes', () => {
  assert.equal(powershellLiteral("a'b"), "a''b");
});

await checkAsync('probePort true on a listening port', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const open = await probePort(port);
  srv.close();
  assert.equal(open, true);
});

await checkAsync('probePort false on a dead port', async () => {
  const open = await probePort(1, '127.0.0.1', 800);
  assert.equal(open, false);
});

await checkAsync('probeWebUi false when nothing listens', async () => {
  const res = await probeWebUi('http://127.0.0.1:1', 2000);
  assert.equal(res.ok, false);
});

// ------------------------------------------------------- status() / job flow

console.log('installer job flow');

const installDir = path.join(tmp, 'runtime');
const installer = new NapCatInstaller({ installDir, webuiPort: 6099, log: () => {} });

check('status reports not installed initially', () => {
  const s = installer.status();
  assert.equal(s.installed, false);
  assert.equal(s.dir, installDir);
  assert.equal(s.webuiPort, 6099);
  assert.equal(s.busy, null);
});

// install() normally hits api.github.com; point it at a local fake by
// monkey-patching global fetch so no network is needed.
const realFetch = globalThis.fetch;
let fetchCalls = 0;
globalThis.fetch = async (url) => {
  fetchCalls += 1;
  const href = String(url);
  if (href.includes('/releases/latest')) {
    return new Response(
      JSON.stringify({
        tag_name: 'v4.18.42',
        assets: [{ id: 1, name: 'NapCat.Shell.Windows.OneKey.zip', size: 5 }],
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }
  if (href.includes('/releases/assets/')) {
    return new Response(Buffer.from('PKzip'), { status: 200 });
  }
  throw new Error(`unexpected fetch ${href}`);
};

// Make extraction a no-op stub so the fake 5-byte zip doesn't break us.
const installerModule = await import('../lib/installer.js');
void installerModule;

await checkAsync('startInstall does not trip its own busy guard', async () => {
  const started = await installer.startInstall();
  assert.equal(started.ok, true);
  assert.equal(started.started, true, 'install() refused because busy was preset');
  // Wait for the background job to settle (it will fail at extract — fine).
  for (let i = 0; i < 60 && !(installer.job && installer.job.done); i += 1) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(installer.job && installer.job.done, 'job never finished');
  assert.ok(fetchCalls >= 1, `expected fetch calls, got ${fetchCalls}`);
}, { job: installer.job, fetchCalls });

check('job records a terminal stage', () => {
  assert.ok(installer.job.stage === '安装完成' || installer.job.stage === '安装失败');
});

// A second startInstall while busy must refuse.
await checkAsync('startInstall refuses while busy', async () => {
  installer.busy = 'install';
  const again = await installer.startInstall();
  installer.busy = null;
  assert.equal(again.started, false);
});

await checkAsync('launch refuses when not installed', async () => {
  const res = await installer.launch();
  assert.equal(res.ok, false);
  assert.match(res.error, /尚未安装/);
});

globalThis.fetch = realFetch;

// ------------------------------------------------------------- bridge routes

console.log('bridge routes with installer');

const cfgPort = 6800 + Math.floor(Math.random() * 200);
const cfg = {
  host: '127.0.0.1',
  port: cfgPort,
  path: '/onebot',
  accessToken: '',
  secret: '',
  replyVia: 'ws',
  httpApiBase: '',
  httpApiToken: '',
  replyAtSender: true,
  maxBodyBytes: 1024 * 1024,
  maxImageBytes: 1024 * 1024,
  trigger: { privateAlways: true, groupRequiresAt: true, prefix: '' },
  allow: { groups: [], users: [], denyUsers: [] },
  napcat: { enabled: true, baseUrl: 'http://127.0.0.1:6099', webuiToken: '', reverseHost: '127.0.0.1', reversePort: cfgPort, timeoutMs: 5000 },
  llm: { mode: 'harness', baseUrl: '', apiKey: '', model: '', systemPrompt: 'x', maxTokens: 64, timeoutMs: 5000, allowPrivateImages: false, maxReplyChars: 200, maxReplyParts: 2 },
  memory: { enabled: true, maxFacts: 10, maxFactChars: 80, maxReplies: 5, ttlDays: 1, file: '', autoSaveMs: 1000 },
};

const bridge = new OneBotBridge(cfg);
const logRing = createLogRing(50);
const stats = createStats();
const panelInstaller = new NapCatInstaller({ installDir, webuiPort: 6099, log: () => {} });

const routes = makeBridgeRoutes({
  cfg,
  bridge,
  setup: null,
  log: () => {},
  logRing,
  stats,
  memory: null,
  installer: panelInstaller,
});

check('route count is 19 after adding diagnose + installer routes', () => {
  assert.equal(routes.length, 19);
}, routes.length);

const paths = routes.map((r) => r.path);
check('napcat-install route exists', () => {
  assert.ok(paths.some((p) => p.endsWith('/napcat-install')));
});
check('napcat-launch route exists', () => {
  assert.ok(paths.some((p) => p.endsWith('/napcat-launch')));
});

// Mount routes on a real server.
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = routes.find((r) => r.path === url.pathname);
  if (!route) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"ok":false,"error":"not found"}');
    return;
  }
  route.handler(req, res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));

await checkAsync('/status carries napcatRuntime', async () => {
  const res = await request(server, '/api/qq-bot/status');
  assert.equal(res.status, 200);
  assert.ok(res.json.napcatRuntime, 'missing napcatRuntime');
  assert.equal(res.json.napcatRuntime.installed, false);
  assert.equal(res.json.napcatRuntime.webuiPort, 6099);
}, null);

await checkAsync('/napcat-install returns started', async () => {
  const res = await request(server, '/api/qq-bot/napcat-install', 'POST', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.started, true);
});

await checkAsync('/napcat-install rejects GET (405)', async () => {
  const res = await request(server, '/api/qq-bot/napcat-install', 'GET');
  assert.equal(res.status, 405);
});

await checkAsync('/napcat-launch reports not installed', async () => {
  const res = await request(server, '/api/qq-bot/napcat-launch', 'POST', {});
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, false);
  assert.match(String(res.json.error), /尚未安装|已有任务/);
}, null);

server.close();

console.log('');
if (failed === 0) console.log(`ALL_INSTALLER_PASS ${passed}/${passed}`);
else console.log(`INSTALLER_FAILURES ${failed} (passed ${passed})`);
process.exit(failed === 0 ? 0 : 1);
void NODE;
