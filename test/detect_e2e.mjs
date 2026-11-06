// E2E test for lib/detect.js — probeOneBot + AutoDetector against REAL ws
// servers (attachUpgrade from lib/ws.js).
//
// Why real servers: a hand-written mock is exactly what let the blank-panel bug
// slip through 10 green suites. Here we exercise the actual RFC6455 handshake,
// real masked client frames, and the real get_version probe/response path.
// Self-contained: Node built-ins + repo lib modules only. No external deps.

import assert from 'node:assert/strict';
import http from 'node:http';
import { attachUpgrade } from '../lib/ws.js';
import { probeOneBot, AutoDetector } from '../lib/detect.js';

let pass = 0;
let fail = 0;

function check(name, fn) {
  try {
    fn();
    pass += 1;
    console.log('PASS', name);
  } catch (err) {
    fail += 1;
    console.log('FAIL', name, '—', err && err.message ? err.message : String(err));
  }
}

async function asyncCheck(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log('PASS', name);
  } catch (err) {
    fail += 1;
    console.log('FAIL', name, '—', err && err.message ? err.message : String(err));
  }
}

/**
 * Start a WS server at `wsPath` whose behavior on a client message is defined
 * by `onMessage(raw, conn)`. Returns { port, dispose, conns }.
 */
async function startServer(wsPath, onMessage, onConnect) {
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const conns = [];
  const disposeUpgrade = attachUpgrade(server, { path: wsPath }, (conn) => {
    conns.push(conn);
    conn.on('message', (raw) => onMessage(raw, conn));
    conn.on('error', () => {});
    conn.on('close', () => {});
    if (onConnect) onConnect(conn);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const dispose = async () => {
    disposeUpgrade();
    for (const c of conns) {
      try { c._terminate(); } catch { /* ignore */ }
    }
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  };
  return { port, dispose, conns };
}

/** A port that is (almost) certainly closed, for the no-server probe case. */
async function closedPort() {
  const s = http.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const p = s.address().port;
  await new Promise((resolve) => s.close(resolve));
  return p;
}

function oneBotResponder(raw, conn) {
  let obj;
  try { obj = JSON.parse(raw); } catch { return; }
  if (obj && obj.action === 'get_version') {
    conn.send(JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: {
        app_name: 'FakeOneBot',
        app_version: '4.18.42',
        protocol_version: 'v11',
      },
      echo: obj.echo,
      self_id: 123456,
    }));
  }
}

function echoResponder(raw, conn) {
  // A "pure echo" service returns exactly what it received. It carries the
  // matching echo but NO data/retcode/status/wording, so it must NOT count.
  conn.send(raw);
}

function lifecycleConnect(conn) {
  // Some implementations push a lifecycle/meta_event before answering any API.
  setTimeout(() => {
    if (!conn.closed) {
      conn.send(JSON.stringify({
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
        self_id: 654321,
        time: Math.floor(Date.now() / 1000),
      }));
    }
  }, 40);
}

async function main() {
  const logs = [];
  const log = (msg) => logs.push(String(msg));

  const onebot = await startServer('/', oneBotResponder);
  const echo = await startServer('/', echoResponder);
  const lifecycle = await startServer('/onebot', () => {}, lifecycleConnect);
  const dead = await closedPort();

  try {
    // ---- probeOneBot: real OneBot get_version response ---------------------
    await asyncCheck('probeOneBot detects a real OneBot get_version response', async () => {
      const r = await probeOneBot(`ws://127.0.0.1:${onebot.port}/`, { timeoutMs: 800 });
      assert.equal(r.ok, true, `reason=${r.reason}`);
      assert.equal(r.appName, 'FakeOneBot');
      assert.equal(r.version, '4.18.42');
      assert.equal(r.selfId, 123456);
      assert.equal(r.url, `ws://127.0.0.1:${onebot.port}/`);
    });

    await asyncCheck('probeOneBot accepts a pushed lifecycle meta_event', async () => {
      const r = await probeOneBot(`ws://127.0.0.1:${lifecycle.port}/onebot`, { timeoutMs: 1500 });
      assert.equal(r.ok, true, `reason=${r.reason}`);
      assert.equal(r.appName, 'OneBot');
      assert.equal(r.selfId, 654321);
    });

    await asyncCheck('probeOneBot does NOT mistake a pure echo service for OneBot', async () => {
      const r = await probeOneBot(`ws://127.0.0.1:${echo.port}/`, { timeoutMs: 600 });
      assert.equal(r.ok, false, 'a raw echo has no data/retcode/status, must be rejected');
      assert.equal(r.url, `ws://127.0.0.1:${echo.port}/`);
      assert.ok(r.reason, 'a reason is recorded');
    });

    await asyncCheck('probeOneBot never rejects on a closed port (resolves ok:false)', async () => {
      const r = await probeOneBot(`ws://127.0.0.1:${dead}/`, { timeoutMs: 800 });
      assert.equal(r.ok, false);
      assert.equal(typeof r.reason, 'string');
    });

    await asyncCheck('probeOneBot resolves (not hangs) on an invalid ws URL', async () => {
      const r = await probeOneBot('http://127.0.0.1:1/', { timeoutMs: 500 });
      assert.equal(r.ok, false);
    });

    // ---- AutoDetector: info() / init() defaults + self-port exclusion ------
    check('info() shape and defaults', () => {
      const detector = new AutoDetector({ info: () => null }, log, { selfPort: 6700 });
      const info = detector.init({});
      assert.equal(info.enabled, true);
      assert.equal(info.status, 'idle');
      assert.equal(info.running, false);
      assert.equal(info.scanning, false);
      assert.deepEqual(info.ports, [3001, 3000, 5700, 8080, 6099, 3333]);
      assert.deepEqual(info.paths, ['/', '/onebot']);
      assert.equal(info.intervalMs, 20000);
      assert.equal(info.timeoutMs, 1500);
      assert.equal(info.host, '127.0.0.1');
      assert.ok(info.excludedPorts.includes(6700), 'own port is always excluded');
      detector.dispose();
    });

    check('init() honors enabled:false and clamps interval/timeout', () => {
      const detector = new AutoDetector({ info: () => null }, log, { selfPort: 6700 });
      const info = detector.init({
        enabled: false,
        intervalMs: 1,
        timeoutMs: 999999,
        ports: [9, 9, 70000, -1, 12345],
      });
      assert.equal(info.enabled, false);
      assert.equal(info.status, 'disabled');
      assert.equal(info.intervalMs, 2000, 'intervalMs clamped to min 2000');
      assert.equal(info.timeoutMs, 10000, 'timeoutMs clamped to max 10000');
      assert.deepEqual(info.ports, [9, 12345], 'ports deduped and range-filtered');
      assert.ok(info.excludedPorts.includes(6700));
      detector.dispose();
    });

    // ---- scanNow(): finds a real server and auto-connects ------------------
    await asyncCheck('scanNow() finds the real OneBot server and auto-connects', async () => {
      const configureCalls = [];
      const forward = {
        info: () => ({ connected: false, url: '', status: 'idle' }),
        configure: (body) => { configureCalls.push(body); return { ...body }; },
      };
      const detector = new AutoDetector(forward, log, { selfPort: 9999 });
      detector.init({ enabled: true, ports: [onebot.port, dead], paths: ['/'], timeoutMs: 700 });
      const events = [];
      detector.on('found', (hit) => events.push(hit));
      const result = await detector.scanNow();
      assert.equal(result.ok, true);
      assert.equal(result.hits.length, 1, 'only the live port is a hit');
      assert.equal(result.hits[0].url, `ws://127.0.0.1:${onebot.port}/`);
      assert.equal(result.hits[0].appName, 'FakeOneBot');
      assert.equal(result.detect.status, 'found');
      assert.ok(result.detect.lastScanAt > 0);
      assert.equal(configureCalls.length, 1, 'forward.configure called exactly once');
      assert.equal(configureCalls[0].url, `ws://127.0.0.1:${onebot.port}/`);
      assert.equal(configureCalls[0].enabled, true);
      assert.equal(events.length, 1, "'found' event emitted");
      detector.dispose();
    });

    // ---- scanNow(): never overwrites a manually configured URL -------------
    await asyncCheck('scanNow() does NOT overwrite a manual forward URL', async () => {
      const configureCalls = [];
      const forward = {
        info: () => ({ connected: false, url: 'ws://127.0.0.1:5555/manual', status: 'idle' }),
        configure: (body) => { configureCalls.push(body); return { ...body }; },
      };
      const detector = new AutoDetector(forward, log, { selfPort: 9999 });
      detector.init({ enabled: true, ports: [onebot.port], paths: ['/'], timeoutMs: 700 });
      const result = await detector.scanNow();
      assert.equal(result.hits.length, 1, 'still reports the candidate');
      assert.equal(configureCalls.length, 0, 'manual URL must never be overwritten');
      detector.dispose();
    });

    // ---- scanNow(): does not auto-connect when already connected ----------
    await asyncCheck('scanNow() does NOT reconfigure an already-connected forward', async () => {
      const configureCalls = [];
      const forward = {
        info: () => ({ connected: true, url: `ws://127.0.0.1:${onebot.port}/`, status: 'connected' }),
        configure: (body) => { configureCalls.push(body); return { ...body }; },
      };
      const detector = new AutoDetector(forward, log, { selfPort: 9999 });
      detector.init({ enabled: true, ports: [onebot.port], paths: ['/'], timeoutMs: 700 });
      const result = await detector.scanNow();
      assert.equal(result.hits.length, 1);
      assert.equal(configureCalls.length, 0, 'no reconfigure while connected');
      detector.dispose();
    });

    // ---- self-port exclusion: probing our own port would loop -------------
    await asyncCheck('scanNow() excludes the plugin own port (no echo loop)', async () => {
      const configureCalls = [];
      const forward = {
        info: () => ({ connected: false, url: '', status: 'idle' }),
        configure: (body) => { configureCalls.push(body); return { ...body }; },
      };
      // Put the REAL server's port in selfPort AND in the candidate list.
      const detector = new AutoDetector(forward, log, { selfPort: onebot.port });
      detector.init({ enabled: true, ports: [onebot.port], paths: ['/'], timeoutMs: 700 });
      const result = await detector.scanNow();
      assert.equal(result.hits.length, 0, 'own port is skipped entirely');
      assert.equal(configureCalls.length, 0);
      assert.ok(result.detect.excludedPorts.includes(onebot.port));
      detector.dispose();
    });

    // ---- setEnabled(): disable still scans, but does not auto-connect ------
    await asyncCheck('setEnabled(false) scans but never auto-connects; status disabled', async () => {
      const configureCalls = [];
      const forward = {
        info: () => ({ connected: false, url: '', status: 'idle' }),
        configure: (body) => { configureCalls.push(body); return { ...body }; },
      };
      const detector = new AutoDetector(forward, log, { selfPort: 9999 });
      detector.init({ enabled: true, ports: [onebot.port], paths: ['/'], timeoutMs: 700 });
      const off = detector.setEnabled(false);
      assert.equal(off.enabled, false);
      assert.equal(off.status, 'disabled');
      assert.equal(off.running, false, 'periodic timer cleared');
      const result = await detector.scanNow();
      assert.equal(result.hits.length, 1, 'manual scan still reports the candidate');
      assert.equal(configureCalls.length, 0, 'but auto-connect is off');
      assert.equal(result.detect.status, 'disabled', 'status stays disabled');
      const on = detector.setEnabled(true);
      assert.equal(on.enabled, true);
      assert.equal(on.running, true, 'periodic timer re-armed');
      detector.dispose();
    });

    // ---- start()/dispose() lifecycle --------------------------------------
    await asyncCheck('start() arms timer; dispose() tears everything down', async () => {
      const forward = {
        info: () => ({ connected: false, url: '', status: 'idle' }),
        configure: () => ({}),
      };
      const detector = new AutoDetector(forward, log, { selfPort: 9999 });
      detector.init({ enabled: true, ports: [dead], paths: ['/'], intervalMs: 60000, timeoutMs: 400 });
      const started = detector.start();
      assert.equal(started.running, true);
      // Let the immediate first scan settle so no dangling probe remains.
      await new Promise((r) => setTimeout(r, 120));
      detector.dispose();
      assert.equal(detector.info().running, false);
      assert.equal(detector.info().scanning, false);
      assert.equal(detector.stopped, true);
    });

    check('start() is a no-op when disabled', () => {
      const detector = new AutoDetector({ info: () => null }, log, { selfPort: 9999 });
      detector.init({ enabled: false, ports: [dead], paths: ['/'] });
      const info = detector.start();
      assert.equal(info.running, false);
      assert.equal(info.status, 'disabled');
      detector.dispose();
    });
  } finally {
    await onebot.dispose();
    await echo.dispose();
    await lifecycle.dispose();
  }

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log('FAIL fatal —', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
