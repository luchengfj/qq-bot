// Minimal RFC 6455 WebSocket *server* implementation using only Node built-ins.
// OneBot v11 "reverse WebSocket" works like this: a bot framework (NapCat /
// Lagrange / LLOneBot / go-cqhttp) connects to us as a WebSocket *client*.
// We accept the upgrade, then exchange JSON text frames with it.
//
// No external dependencies: `crypto` for the Sec-WebSocket-Accept hash,
// `http` for the upgrade handshake, raw sockets for framing.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

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
 * A single accepted WebSocket connection. Wraps a net.Socket.
 * Emits: 'message' (string), 'close', 'error', 'pong'.
 */
export class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
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
   * Client frames MUST be masked per RFC 6455; we enforce it.
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

    if (!masked) {
      // RFC 6455 §5.1: a server MUST close the connection on an unmasked
      // client frame. Be strict to avoid ambiguous framing.
      this._fail(new Error('Unmasked client frame'));
      return null;
    }

    if (buf.length < offset + 4) return null;
    const mask = buf.subarray(offset, offset + 4);
    offset += 4;

    if (buf.length < offset + len) return null;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    this.buffer = buf.subarray(offset + len);

    // Unmask in place.
    for (let i = 0; i < payload.length; i++) {
      payload[i] ^= mask[i & 3];
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

  /** Write one server->client frame (unmasked). */
  _writeFrame(opcode, payload = Buffer.alloc(0)) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.alloc(2);
      header[1] = len; // masked bit = 0
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
    try {
      this.socket.write(Buffer.concat([header, payload]));
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
 * Attach a WebSocket upgrade handler to an existing http.Server.
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
          'HTTP/1.1 401 Unauthorized\r\n' +
            'Connection: close\r\n' +
            'Content-Length: 0\r\n' +
            '\r\n',
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
        'HTTP/1.1 400 Bad Request\r\n' +
          'Connection: close\r\n' +
          'Content-Length: 0\r\n' +
          '\r\n',
      );
      socket.destroy();
      return;
    }

    const accept = acceptKey(key);
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        '\r\n',
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
