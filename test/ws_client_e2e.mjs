// E2E test for lib/ws.js — reverse-WS server + forward-WS client round trip.
// Self-contained: node built-ins + repo lib modules only. No external deps.

import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { attachUpgrade, acceptKey, connectWebSocket } from '../lib/ws.js';

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

function once(emitter, event) {
  return new Promise((resolve, reject) => {
    const onEvent = (...args) => {
      emitter.off('error', onError);
      resolve(args);
    };
    const onError = (err) => {
      emitter.off(event, onEvent);
      reject(err);
    };
    emitter.once(event, onEvent);
    if (event !== 'error') emitter.once('error', onError);
  });
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CRLF = '\r\n';

async function main() {
  // (f) acceptKey matches the RFC6455 GUID computation.
  check('acceptKey matches RFC6455 GUID sha1/base64', () => {
    const key = 'dGhlIHNhbXBsZSBub25jZQ==';
    const expected = crypto
      .createHash('sha1')
      .update(key + GUID, 'binary')
      .digest('base64');
    assert.equal(acceptKey(key), expected);
    assert.equal(acceptKey(key), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  // (e) connectWebSocket rejects a bad http:// URL with the exact message.
  await asyncCheck('connectWebSocket rejects http:// URL with exact message', async () => {
    let caught = null;
    try {
      await connectWebSocket('http://127.0.0.1:9/onebot');
    } catch (err) {
      caught = err;
    }
    assert.ok(caught, 'expected a rejection');
    assert.equal(caught.message, '正向 WebSocket 地址必须以 ws:// 或 wss:// 开头');
  });

  // Start a REAL http server with attachUpgrade('/onebot'). Collect every
  // accepted server-side connection so the raw-socket check can grab its own.
  const server = http.createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const serverConns = [];
  const disposeUpgrade = attachUpgrade(server, { path: '/onebot' }, (conn) => {
    serverConns.push(conn);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;

  // (a) handshake succeeds and client conn emits no error.
  const clientConn = await connectWebSocket(`ws://127.0.0.1:${port}/onebot`);
  const serverConn = serverConns[0];

  await asyncCheck('handshake succeeds: client + server connections are live', async () => {
    assert.ok(clientConn, 'client connection exists');
    assert.ok(serverConn, 'server connection exists');
    assert.equal(clientConn.closed, false);
    assert.equal(serverConn.closed, false);
    assert.equal(clientConn.maskOutgoing, true, 'client frames are masked');
    assert.equal(serverConn.requireMaskedIncoming, true, 'server enforces masked incoming');
  });

  // Track any client-side error during the whole session.
  let clientError = null;
  clientConn.on('error', (err) => { clientError = err; });

  // (b) client -> server masked TEXT frame arrives as 'message'.
  await asyncCheck('client -> server masked TEXT frame delivers message', async () => {
    const msgPromise = once(serverConn, 'message');
    clientConn.send('你好 from 客户端');
    const [text] = await msgPromise;
    assert.equal(text, '你好 from 客户端');
  });

  // (c) server -> client TEXT frame arrives as 'message'.
  await asyncCheck('server -> client TEXT frame delivers message', async () => {
    const msgPromise = once(clientConn, 'message');
    serverConn.send('pong from 服务端');
    const [text] = await msgPromise;
    assert.equal(text, 'pong from 服务端');
  });

  // ping/pong round trip is a bonus sanity check of control frames.
  await asyncCheck('client ping() gets a pong from server', async () => {
    const pongPromise = once(clientConn, 'pong');
    clientConn.ping();
    await pongPromise;
  });

  check('client conn emitted no error during round trips', () => {
    assert.equal(clientError, null, clientError ? clientError.message : '');
  });

  // (d) server rejects an UNMASKED client frame. Use a raw net socket: complete
  // a valid WS handshake, then send a FIN+TEXT frame with the MASK bit CLEAR.
  // Per RFC6455 5.1 the server must fail/close the connection. We capture the
  // server-side WsConnection created for this raw socket and assert it emits
  // an 'error' with the exact 'Unmasked client frame' message, then 'close'.
  await asyncCheck('server rejects an UNMASKED client frame (error + close)', async () => {
    const key = crypto.randomBytes(16).toString('base64');
    const sock = net.createConnection(port, '127.0.0.1');
    await once(sock, 'connect');
    sock.write(
      `GET /onebot HTTP/1.1${CRLF}` +
        `Host: 127.0.0.1:${port}${CRLF}` +
        `Upgrade: websocket${CRLF}` +
        `Connection: Upgrade${CRLF}` +
        `Sec-WebSocket-Key: ${key}${CRLF}` +
        `Sec-WebSocket-Version: 13${CRLF}` +
        CRLF,
    );

    // Wait until the raw client has received the 101 response headers.
    await new Promise((resolve, reject) => {
      let buf = '';
      const timer = setTimeout(() => reject(new Error('timed out waiting for handshake 101')), 2000);
      const onData = (chunk) => {
        buf += chunk.toString('latin1');
        if (buf.includes('\r\n\r\n')) {
          clearTimeout(timer);
          sock.off('data', onData);
          assert.ok(buf.startsWith('HTTP/1.1 101'), `expected 101, got: ${buf.split(CRLF)[0]}`);
          resolve();
        }
      };
      sock.on('data', onData);
      sock.once('error', reject);
    });

    // The upgrade handler created a WsConnection for this raw socket before
    // the 101 reached us, so it is the last element of serverConns.
    assert.ok(serverConns.length >= 2, 'expected a second server-side connection');
    const rawServerConn = serverConns[serverConns.length - 1];
    const errPromise = new Promise((resolve) => {
      let gotError = null;
      rawServerConn.once('error', (err) => { gotError = err; });
      rawServerConn.once('close', () => resolve(gotError));
      setTimeout(() => resolve(gotError), 2000);
    });

    // FIN + TEXT (0x81), length 5, MASK bit = 0, payload "hello".
    const frame = Buffer.concat([
      Buffer.from([0x81, 0x05]),
      Buffer.from('hello', 'utf8'),
    ]);
    sock.write(frame);

    const gotError = await errPromise;
    assert.ok(gotError, 'server should emit an error for the unmasked frame');
    assert.equal(gotError.message, 'Unmasked client frame');
    assert.equal(rawServerConn.closed, true, 'server should terminate the connection');
    sock.destroy();
  });

  // Cleanup: terminate both connections, stop the server.
  clientConn._terminate();
  serverConn._terminate();
  for (const c of serverConns) {
    try { c._terminate(); } catch { /* ignore */ }
  }
  disposeUpgrade();
  // server.close() is best-effort: never hang the test on a lingering socket.
  await Promise.race([
    new Promise((resolve) => server.close(resolve)),
    new Promise((resolve) => setTimeout(resolve, 1000)),
  ]);

  console.log(`\nRESULT: ${pass} PASS, ${fail} FAIL`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.log('FAIL fatal —', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
