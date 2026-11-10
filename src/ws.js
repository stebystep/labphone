'use strict';
// Minimal RFC 6455 WebSocket server side (no extensions) so LabPhone has zero npm dependencies.
const crypto = require('crypto');
const { EventEmitter } = require('events');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

class WsConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.fragments = null;
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => { if (!this.closed) { this.closed = true; this.emit('close'); } });
    socket.on('error', () => socket.destroy());
  }

  send(data) {
    if (this.closed) return;
    const isText = typeof data === 'string';
    const payload = isText ? Buffer.from(data) : data;
    if (!isText && this.socket.writableLength > 512 * 1024) return; // drop audio when the client is slow
    this.socket.write(Buffer.concat([frameHeader(isText ? 0x1 : 0x2, payload.length), payload]));
  }

  sendJson(obj) { this.send(JSON.stringify(obj)); }

  close() {
    if (this.closed) return;
    this.socket.write(frameHeader(0x8, 0));
    this.socket.end();
  }

  _onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0] & 0x80) !== 0;
      const opcode = this.buf[0] & 0x0f;
      const masked = (this.buf[1] & 0x80) !== 0;
      let len = this.buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      if (len > 16 * 1024 * 1024 || !masked) { this.socket.destroy(); return; } // clients must mask
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);

      if (opcode === 0x8) { this.close(); return; }
      if (opcode === 0x9) { this.socket.write(Buffer.concat([frameHeader(0xa, payload.length), payload])); continue; }
      if (opcode === 0xa) continue;
      if (opcode === 0x0 && this.fragments) {
        this.fragments.parts.push(payload);
      } else if (opcode === 0x1 || opcode === 0x2) {
        this.fragments = { opcode, parts: [payload] };
      } else continue;
      if (!fin) continue;
      const whole = Buffer.concat(this.fragments.parts);
      const op = this.fragments.opcode;
      this.fragments = null;
      if (op === 0x1) this.emit('text', whole.toString('utf8')); else this.emit('binary', whole);
    }
  }
}

function frameHeader(opcode, len) {
  if (len < 126) return Buffer.from([0x80 | opcode, len]);
  if (len < 65536) { const h = Buffer.alloc(4); h[0] = 0x80 | opcode; h[1] = 126; h.writeUInt16BE(len, 2); return h; }
  const h = Buffer.alloc(10); h[0] = 0x80 | opcode; h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); return h;
}

function acceptUpgrade(req, socket, head) {
  const key = req.headers['sec-websocket-key'];
  if (!key || (req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new WsConnection(socket);
  if (head && head.length) ws._onData(head);
  return ws;
}

module.exports = { acceptUpgrade, WsConnection };
