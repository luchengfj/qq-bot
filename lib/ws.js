// Minimal RFC 6455 WebSocket implementation using only Node built-ins.
// Two directions are supported:
//   * reverse WS (server) - a OneBot implementation connects to US as a
//     client; we accept the upgrade via attachUpgrade().
//   * forward WS (client) - WE connect out to an already-running OneBot
//     server via connectWebSocket(). Client frames are masked.
//
// No external dependencies: crypto for hashing/masks, http/https for the
// handshake, raw sockets for framing.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const CRLF = String.fromCharCode(13, 10);

const OP = {
  CONT: 0x0,
  TEXT: 0x1,
  BIN: 0x2,
  CLOSE: 0x8,
  PING: 0x9,
  PONG: 0xa,
};

// Reasonable ceiling for a single assembled message (defensive: OneBot events
// are small JSON with image *URLs*, not raw image bytes). 16 MiB.
const MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * A single WebSocket connection. Wraps a net.Socket.
 * Emits: 'message' (string), 'close', 'error', 'pong'.
 *
 * RFC 6455 masking rules:
 *   - server-side (accepted) connection: incoming frames MUST be masked,
 *     outgoing frames MUST NOT be masked;
 *   - client-side (outbound) connection: the opposite.
 * Pass { client: true } for outbound connections.
 */
export class WsConnection extends EventEmitter {
  constructor(socket, options = {}) {
    super();
    this.socket = socket;
    this.maskOutgoing = Boolean(options.client);
    this.requireMaskedIncoming = !options.client;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOpcode = null;
    this.closed = false;
    this.alive = true;

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose());
    socket.on('error', (err) => this._onError(err));
    // Half-open TCP connections can otherwise hang forever.
    socket.setNoDelay(true);
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    // Parse as many complete frames as the buffer allows.
    while (true) {
      const frame = this._readFrame();
      if (frame === null) break; // need more bytes
      this._handleFrame(frame);
      if (this.closed) break;
    }
  }

  /**
   * Try to read exactly one frame from the buffer. Returns null if incomplete,
   * otherwise returns { fin, opcode, payload } and advances the buffer.
   * Server-side connections enforce that client frames MUST be masked.
   */
  _readFrame() {
    const buf = this.buffer;
    if (buf.length < 2) return null;

    const b0 = buf[0];
    const b1 = buf[1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let offset = 2;

    if (len === 126) {
      if (buf.length < offset + 2) return null;
      len = buf.readUInt16BE(offset);
      offset += 2;
    } else if (len === 127) {
      if (buf.length < offset + 8) return null;
      const big = buf.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE_BYTES)) {
        this._fail(new Error('WebSocket frame too large'));
        return null;
      }
      len = Number(big);
      offset += 8;
    }

    if (!masked && this.requireMaskedIncoming) {
      // RFC 6455 5.1: a server MUST close the connection on an unmasked
      // client frame. Be strict to avoid ambiguous framing.
      this._fail(new Error('Unmasked client frame'));
      return null;
    }

    let mask = null;
    if (masked) {
      if (buf.length < offset + 4) return null;
      mask = buf.subarray(offset, offset + 4);
      offset += 4;
    }

    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    this.buffer = buf.subarray(offset + len);

    // Unmask in place (only when the peer actually masked the frame).
    if (mask) {
      for (let i = 0; i < payload.length; i++) {
        payload[i] ^= mask[i & 3];
      }
    }
    return { fin, opcode, payload };
  }

  _handleFrame(frame) {
    const { fin, opcode, payload } = frame;

    switch (opcode) {
      case OP.PING:
        // Reply with the same application data as a pong.
        this._writeFrame(OP.PONG, payload);
        return;
      case OP.PONG:
        this.alive = true;
        this.emit('pong');
        return;
      case OP.CLOSE:
        // Echo close, then terminate.
        this._writeFrame(OP.CLOSE, payload);
        this._terminate();
        return;
      case OP.TEXT:
      case OP.BIN:
      case OP.CONT:
        break;
      default:
        this._fail(new Error(`Unsupported opcode ${opcode}`));
        return;
    }

    // Fragmentation handling.
    if (opcode === OP.CONT) {
      if (this.fragmentOpcode === null) {
        this._fail(new Error('Unexpected continuation frame'));
        return;
      }
      this._appendFragment(fin, payload);
      return;
    }

    if (this.fragmentOpcode !== null) {
      this._fail(new Error('Expected continuation frame'));
      return;
    }

    if (fin) {
      this._deliver(opcode, payload);
    } else {
      this.fragmentOpcode = opcode;
      this._appendFragment(false, payload);
    }
  }

  _appendFragment(fin, payload) {
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > MAX_MESSAGE_BYTES) {
      this._fail(new Error('Fragmented message too large'));
      return;
    }
    if (fin) {
      const opcode = this.fragmentOpcode;
      const assembled = Buffer.concat(this.fragments, this.fragmentBytes);
      this.fragments = [];
      this.fragmentBytes = 0;
      this.fragmentOpcode = null;
      this._deliver(opcode, assembled);
    }
  }

  _deliver(opcode, payload) {
    if (opcode === OP.TEXT) {
      this.emit('message', payload.toString('utf8'));
    } else if (opcode === OP.BIN) {
      this.emit('message', payload.toString('utf8'));
    }
  }

  /** Write one frame. Client connections MUST mask their outgoing frames. */
  _writeFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    const maskBit = this.maskOutgoing ? 0x80 : 0;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len | maskBit;
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126 | maskBit;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127 | maskBit;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    let body = payload;
    if (this.maskOutgoing) {
      const mask = crypto.randomBytes(4);
      const masked = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i += 1) masked[i] = payload[i] ^ mask[i & 3];
      body = Buffer.concat([mask, masked]);
    }
    try {
      this.socket.write(Buffer.concat([header, body]));
    } catch (err) {
      this._onError(err);
    }
  }

  /** Send a UTF-8 text message. */
  send(text) {
    const payload = Buffer.from(String(text), 'utf8');
    this._writeFrame(OP.TEXT, payload);
  }

  ping() {
    this.alive = false;
    this._writeFrame(OP.PING, Buffer.from('qq-bot', 'utf8'));
  }

  _fail(err) {
    this._onError(err);
    this._terminate();
  }

  _onClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  _onError(err) {
    // Only surface an 'error' event if someone is listening, otherwise Node
    // would throw. The bridge always attaches one.
    if (this.listenerCount('error') > 0) this.emit('error', err);
  }

  _terminate() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.socket.end();
    } catch {
      /* ignore */
    }
    try {
      this.socket.destroy();
    } catch {
      /* ignore */
    }
    this.emit('close');
  }
}

/**
 * Compute the Sec-WebSocket-Accept response header value.
 */
export function acceptKey(key) {
  return crypto
    .createHash('sha1')
    .update(String(key) + GUID, 'binary')
    .digest('base64');
}

/**
 * Attach a WebSocket upgrade handler to an existing http.Server (reverse WS).
 *
 * @param {import('node:http').Server} server
 * @param {{ path?: string, accessToken?: string }} options
 * @param {(conn: WsConnection, req: import('node:http').IncomingMessage) => void} onConnection
 * @returns {() => void} disposer that removes the listener
 */
export function attachUpgrade(server, options, onConnection) {
  const path = options.path || '/onebot';
  const token = options.accessToken || '';

  const handler = (req, socket, head) => {
    // Only handle our configured path.
    let urlPath;
    try {
      urlPath = new URL(req.url, 'http://localhost').pathname;
    } catch {
      urlPath = req.url || '';
    }
    if (urlPath !== path) {
      socket.destroy();
      return;
    }

    // Optional access-token check (Authorization: Bearer <token> or ?access_token=).
    if (token) {
      const auth = req.headers['authorization'] || '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      let queryToken = '';
      try {
        queryToken = new URL(req.url, 'http://localhost').searchParams.get('access_token') || '';
      } catch {
        /* ignore */
      }
      if (bearer !== token && queryToken !== token) {
        socket.write(
          `HTTP/1.1 401 Unauthorized${CRLF}` +
            `Connection: close${CRLF}` +
            `Content-Length: 0${CRLF}` +
            CRLF,
        );
        socket.destroy();
        return;
      }
    }

    // Validate the handshake headers.
    const key = req.headers['sec-websocket-key'];
    const upgrade = String(req.headers['upgrade'] || '').toLowerCase();
    const connection = String(req.headers['connection'] || '').toLowerCase();
    if (!key || upgrade !== 'websocket' || !connection.includes('upgrade')) {
      socket.write(
        `HTTP/1.1 400 Bad Request${CRLF}` +
          `Connection: close${CRLF}` +
          `Content-Length: 0${CRLF}` +
          CRLF,
      );
      socket.destroy();
      return;
    }

    const accept = acceptKey(key);
    socket.write(
      `HTTP/1.1 101 Switching Protocols${CRLF}` +
        `Upgrade: websocket${CRLF}` +
        `Connection: Upgrade${CRLF}` +
        `Sec-WebSocket-Accept: ${accept}${CRLF}` +
        CRLF,
    );

    const conn = new WsConnection(socket);
    // Wire up listeners FIRST: some clients pipeline the first data frame in
    // the same TCP segment as the upgrade, so `head` may already contain a
    // complete frame. Feeding `head` before listeners exist would drop it.
    onConnection(conn, req);
    // Any bytes already read past the HTTP headers belong to the first frame.
    if (head && head.length > 0) conn._onData(head);
  };

  server.on('upgrade', handler);
  return () => server.off('upgrade', handler);
}

/**
 * Open an OUTBOUND WebSocket connection (forward WS - the plugin acts as a
 * client and connects to a OneBot implementation that is already running).
 *
 * This is what makes the "zero-download" flow able to reach real QQ: instead
 * of downloading/installing NapCat, the user points us at any already-running
 * OneBot v11 forward-WS server.
 *
 * @param {string} url - ws:// or wss:// URL
 * @param {{ accessToken?: string, timeoutMs?: number }} options
 * @returns {Promise<WsConnection>} a client-mode connection
 */
export function connectWebSocket(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`无效的正向 WebSocket 地址: ${url}`));
      return;
    }
    const secure = parsed.protocol === 'wss:';
    if (parsed.protocol !== 'ws:' && !secure) {
      reject(new Error('正向 WebSocket 地址必须以 ws:// 或 wss:// 开头'));
      return;
    }
    const mod = secure ? https : http;
    const key = crypto.randomBytes(16).toString('base64');
    const headers = {
      Connection: 'Upgrade',
      Upgrade: 'websocket',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      Host: parsed.host,
    };
    if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`;

    let settled = false;
    const finish = (err, conn) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(conn);
    };

    const req = mod.request({
      hostname: parsed.hostname,
      port: Number(parsed.port) || (secure ? 443 : 80),
      path: `${parsed.pathname || '/'}${parsed.search || ''}`,
      headers,
      timeout: Number(options.timeoutMs) || 10000,
    });

    req.on('upgrade', (res, socket, head) => {
      const accept = String(res.headers['sec-websocket-accept'] || '');
      if (accept !== acceptKey(key)) {
        socket.destroy();
        finish(new Error('WebSocket 握手校验失败（Sec-WebSocket-Accept 不匹配）'));
        return;
      }
      const conn = new WsConnection(socket, { client: true });
      finish(null, conn);
      // Deliver pipelined bytes only AFTER the caller has had a chance to
      // attach listeners (the await continuation is a microtask; this is a
      // macrotask). Without this the first event would be silently dropped.
      if (head && head.length) {
        setImmediate(() => {
          if (!conn.closed) conn._onData(head);
        });
      }
    });
    req.on('response', (res) => {
      res.resume();
      finish(new Error(`对方拒绝 WebSocket 升级 (HTTP ${res.statusCode})`));
      req.destroy();
    });
    req.on('error', (err) => finish(new Error(`正向 WebSocket 连接失败: ${err.message}`)));
    req.on('timeout', () => {
      req.destroy();
      finish(new Error('正向 WebSocket 连接超时'));
    });
    req.end();
  });
}
