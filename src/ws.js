// A tiny WebSocket server (RFC 6455), so the project needs no downloads.
// Supports text messages, ping/pong and close. That is all the game needs.
import { createHash } from 'node:crypto';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;

class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.frag = [];
    this.closed = false;
    this.alive = true;
    this.onmessage = () => {};
    this.onclose = () => {};
    socket.on('data', (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this._parse();
    });
    socket.on('close', () => this._finish());
    socket.on('error', () => this._finish());
  }

  _parse() {
    for (;;) {
      if (this.closed || this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = !!(b0 & 0x80);
      const op = b0 & 0x0f;
      const masked = !!(b1 & 0x80);
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(MAX_PAYLOAD)) return this.close(1009);
        len = Number(big);
        off = 10;
      }
      if (len > MAX_PAYLOAD) return this.close(1009);
      if (!masked) return this.close(1002); // browsers always mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, payload) {
    if (op === 0x8) return this.close(1000);
    if (op === 0x9) return this._write(0xa, payload);
    if (op === 0xa) {
      this.alive = true;
      return undefined;
    }
    if (op === 0x1 || op === 0x0) {
      if (op === 0x1) this.frag = [payload];
      else this.frag.push(payload);
      if (this.frag.reduce((n, b) => n + b.length, 0) > MAX_PAYLOAD) return this.close(1009);
      if (fin) {
        const text = Buffer.concat(this.frag).toString('utf8');
        this.frag = [];
        this.onmessage(text);
      }
      return undefined;
    }
    return this.close(1003); // binary frames are not used
  }

  send(text) {
    if (!this.closed) this._write(0x1, Buffer.from(text));
  }

  ping() {
    if (!this.closed) this._write(0x9, Buffer.alloc(0));
  }

  _write(op, payload) {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | op, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | op;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | op;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    try {
      this.socket.write(Buffer.concat([header, payload]));
    } catch {
      this._finish();
    }
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this._write(0x8, p);
    try {
      this.socket.end();
    } catch {
      /* already gone */
    }
    this._finish();
  }

  terminate() {
    this.socket.destroy();
    this._finish();
  }

  _finish() {
    if (this.closed) return;
    this.closed = true;
    this.onclose();
  }
}

// Completes the WebSocket handshake. Returns a connection, or null if the request is not valid.
export function upgrade(req, socket) {
  const key = req.headers['sec-websocket-key'];
  if (String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
    socket.destroy();
    return null;
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  socket.setNoDelay(true);
  return new WsConn(socket);
}
