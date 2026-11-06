// E2E test for lib/forward.js — normalizeForwardUrl + ForwardManager against
// a REAL ws server (attachUpgrade from lib/ws.js).
// Self-contained: node built-ins + repo lib modules only. No external deps.

import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUpgrade } from '../lib/ws.js';
import { normalizeForwardUrl, defaultStorePath, ForwardManager } from '../lib/forward.js';

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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE = path.join(__dirname, '_forward_store.json');

async function main() {
  // ---- normalizeForwardUrl -------------------------------------------------
  check('normalizeForwardUrl accepts ws:// and adds trailing /', () => {
    assert.equal(normalizeForwardUrl('ws://127.0.0.1:3001'), 'ws://127.0.0.1:3001/');
  });
  check('normalizeForwardUrl accepts wss:// and preserves path/search', () => {
    assert.equal(
      normalizeForwardUrl('wss://example.com/onebot?x=1'),
      'wss://example.com/onebot?x=1',
    );
  });
  check('normalizeForwardUrl rejects http:// with meaningful Chinese error', () => {
    assert.throws(
      () => normalizeForwardUrl('http://127.0.0.1:3001'),
      (err) => /必须以 ws:\/\/ 或 wss:\/\/ 开头/.test(err.message) && /不是 http/.test(err.message),
    );
  });
  check('normalizeForwardUrl rejects userinfo', () => {
    assert.throws(
      () => normalizeForwardUrl('ws://user:pass@127.0.0.1:3001/'),
      (err) => /不能包含用户名\/密码/.test(err.message),
    );
  });
  check('normalizeForwardUrl rejects empty with meaningful Chinese error', () => {
    assert.throws(
      () => normalizeForwardUrl(''),
      (err) => /请填写正向 WebSocket 地址/.test(err.message),
    );
    assert.throws(
      () => normalizeForwardUrl('   '),
      (err) => /请填写正向 WebSocket 地址/.test(err.message),
    );
  });
  check('normalizeForwardUrl rejects malformed URL', () => {
    assert.throws(
      () => normalizeForwardUrl('://not-a-url'),
      (err) => /地址格式不正确/.test(err.message),
    );
  });
  check('defaultStorePath returns a string ending in qq-bot-forward.json', () => {
    const p = defaultStorePath();
    assert.equal(typeof p, 'string');
    assert.ok(p.endsWith(path.join('.dsh', 'qq-bot-forward.json')));
  });

  // ---- ForwardManager against a REAL ws server -----------------------------
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  // Track server-side connections so cleanup can terminate any half-open
  // sockets left behind (Windows keeps upgraded sockets alive after the
  // client side calls _terminate(); server.close() would otherwise hang).
  const serverConns = [];
  const disposeUpgrade = attachUpgrade(server, { path: '/onebot' }, (conn) => {
    serverConns.push(conn);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  const targetUrl = `ws://127.0.0.1:${port}/onebot`;

  // Bridge stub records attachConnection calls.
  const calls = [];
  const bridge = {
    attachConnection(conn, meta) {
      calls.push({ conn, meta });
    },
  };

  // Ensure a clean slate, and always remove the temp store at the end.
  try { fs.unlinkSync(STORE); } catch { /* not present */ }

  let manager = null;
  try {
    manager = new ForwardManager(bridge, () => {}, { storePath: STORE });

    // (a) init({enabled:false}) -> info().status === 'idle'
    check('init({enabled:false}) sets status idle', () => {
      const info = manager.init({ enabled: false });
      assert.equal(info.status, 'idle');
      assert.equal(info.connected, false);
      assert.equal(info.enabled, false);
    });

    // (b) configure valid url -> eventually status 'connected', connected true.
    await asyncCheck('configure(valid ws url) reaches connected (poll <=3s)', async () => {
      manager.configure({ url: targetUrl });
      const deadline = Date.now() + 3000;
      let info = manager.info();
      while (Date.now() < deadline) {
        info = manager.info();
        if (info.status === 'connected' && info.connected === true) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      assert.equal(info.status, 'connected', `status=${info.status}, lastError=${info.lastError}`);
      assert.equal(info.connected, true);
      assert.equal(info.url, normalizeForwardUrl(targetUrl));
      assert.equal(info.enabled, true);
      assert.ok(info.lastConnectAt > 0, 'lastConnectAt should be set');
    });

    // (c) bridge.attachConnection called with {selfId:'',role:'Forward'}.
    check('bridge.attachConnection called with {selfId:"",role:"Forward"}', () => {
      assert.ok(calls.length >= 1, 'attachConnection was called');
      const last = calls[calls.length - 1];
      assert.deepEqual(last.meta, { selfId: '', role: 'Forward' });
      assert.ok(last.conn && typeof last.conn.send === 'function', 'conn is a WsConnection');
    });

    // (d) disconnect() -> status 'disabled', connected false, store file has url.
    check('disconnect() sets disabled, connected false, persists store', () => {
      const info = manager.disconnect();
      assert.equal(info.status, 'disabled');
      assert.equal(info.connected, false);
      const stored = JSON.parse(fs.readFileSync(STORE, 'utf8'));
      assert.equal(stored.url, normalizeForwardUrl(targetUrl));
      assert.equal(stored.enabled, false);
      assert.ok(fs.existsSync(STORE), 'storePath file exists');
    });

    // (e) configure({url:'http://bad'}) throws.
    check('configure({url:"http://bad"}) throws', () => {
      assert.throws(
        () => manager.configure({ url: 'http://bad' }),
        (err) => /不是 http|必须以 ws:\/\/ 或 wss:\/\/ 开头/.test(err.message),
      );
    });

    // (f) dispose() is safe (idempotent).
    check('dispose() is safe to call', () => {
      manager.dispose();
      manager.dispose();
      assert.equal(manager.info().status, 'idle');
    });
  } finally {
    // IMPORTANT: stop reconnect timers + connections so the process can exit.
    if (manager) manager.dispose();
    disposeUpgrade();
    for (const c of serverConns) {
      try { c._terminate(); } catch { /* ignore */ }
    }
    // server.close() is best-effort: never hang the test on a lingering socket.
    await Promise.race([
      new Promise((resolve) => server.close(resolve)),
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
    try { fs.unlinkSync(STORE); } catch { /* ignore */ }
  }

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log('FAIL fatal —', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
