'use strict';
// One RTP/RTCP media stream (RFC 3550) carrying G.711 audio, RFC 4733 DTMF events,
// optionally protected with SRTP/SRTCP (RFC 3711).
const dgram = require('dgram');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const g711 = require('./g711');

const FRAME_SAMPLES = 160; // 20 ms at 8 kHz
const DTMF_EVENTS = '0123456789*#ABCD';

async function bindPair(bindHost, min, max) {
  const span = Math.floor((max - min) / 2);
  const start = Math.floor(Math.random() * span);
  for (let i = 0; i < span; i++) {
    const port = min + 2 * ((start + i) % span);
    const rtp = dgram.createSocket('udp4');
    const rtcp = dgram.createSocket('udp4');
    try {
      await bind(rtp, port, bindHost);
      await bind(rtcp, port + 1, bindHost);
      return { rtp, rtcp, port };
    } catch {
      rtp.close();
      try { rtcp.close(); } catch { /* not bound */ }
    }
  }
  throw new Error(`no free RTP port pair in ${min}-${max}`);
}

function bind(sock, port, host) {
  return new Promise((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(port, host, () => { sock.off('error', reject); resolve(); });
  });
}

class RtpSession extends EventEmitter {
  static async create({ bindHost = '0.0.0.0', portMin = 40000, portMax = 40999 } = {}) {
    const pair = await bindPair(bindHost, portMin, portMax);
    return new RtpSession(pair);
  }

  constructor({ rtp, rtcp, port }) {
    super();
    this.rtp = rtp;
    this.rtcp = rtcp;
    this.port = port;
    this.remote = null; // { address, port, rtcpPort }
    this.codec = { pt: 0, name: 'PCMU' };
    this.dtmfPt = 101;
    this.srtpTx = null;
    this.srtpRx = null;
    this.direction = 'sendrecv';
    this.muted = false;
    this.tone = false;
    this.queue = [];
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.ts = crypto.randomBytes(4).readUInt32BE(0);
    this.cname = `labphone-${crypto.randomBytes(4).toString('hex')}`;
    this.dtmfQueue = [];
    this.dtmfActive = null;
    this.tonePhase = 0;
    this.firstPacket = true;
    this.timer = null;
    this.rtcpTimer = null;
    this.stats = {
      sent: 0, sentBytes: 0, received: 0, receivedBytes: 0, lost: 0, jitterMs: 0,
      srtpAuthFailures: 0, unknownPt: 0, remoteSsrc: null, lastReceived: null,
      remoteReport: null, dtmfSent: 0, dtmfReceived: 0,
    };
    this.rx = { baseSeq: null, maxSeq: 0, cycles: 0, transit: null, jitter: 0, lastDtmfTs: null, expectedPrior: 0, receivedPrior: 0, lastSr: 0, lastSrTime: 0 };
    this.rtp.on('message', (buf, rinfo) => this._onRtp(buf, rinfo));
    this.rtcp.on('message', (buf, rinfo) => this._onRtcp(buf, rinfo));
    this.rtp.on('error', () => {});
    this.rtcp.on('error', () => {});
  }

  configure({ remoteAddress, remotePort, remoteRtcpPort, codec, dtmfPt, srtpTx, srtpRx, direction }) {
    if (remoteAddress && remotePort) this.remote = { address: remoteAddress, port: remotePort, rtcpPort: remoteRtcpPort || remotePort + 1 };
    if (codec) this.codec = codec;
    if (dtmfPt !== undefined) this.dtmfPt = dtmfPt;
    if (srtpTx !== undefined) this.srtpTx = srtpTx;
    if (srtpRx !== undefined) this.srtpRx = srtpRx;
    if (direction) this.direction = direction;
  }

  start() {
    if (this.timer) return;
    const t0 = process.hrtime.bigint();
    let sentFrames = 0;
    this.timer = setInterval(() => {
      const elapsed = Number((process.hrtime.bigint() - t0) / 1000000n);
      let due = Math.floor(elapsed / 20) - sentFrames;
      if (due > 5) { sentFrames += due - 5; due = 5; } // after a stall, don't burst
      for (let i = 0; i < due; i++) { this._tick(); sentFrames++; }
    }, 10);
    this.rtcpTimer = setInterval(() => this._sendRtcp(), 5000);
  }

  stop() {
    clearInterval(this.timer);
    clearInterval(this.rtcpTimer);
    this.timer = null;
    if (this.remote && this.stats.sent) this._sendRtcp(true);
    setTimeout(() => {
      try { this.rtp.close(); } catch { /* closed */ }
      try { this.rtcp.close(); } catch { /* closed */ }
    }, 50);
  }

  pushAudio(pcm) {
    this.queue.push(pcm);
    if (this.queue.length > 6) this.queue.splice(0, this.queue.length - 3); // keep latency bounded
  }

  sendDtmf(digit) {
    const ev = DTMF_EVENTS.indexOf(String(digit).toUpperCase());
    if (ev < 0) return false;
    this.dtmfQueue.push(ev);
    return true;
  }

  get canSend() { return this.direction === 'sendrecv' || this.direction === 'sendonly'; }

  _tick() {
    const frame = this.queue.shift();
    if (!this.remote || !this.canSend) { this.ts = (this.ts + FRAME_SAMPLES) >>> 0; return; }

    if (!this.dtmfActive && this.dtmfQueue.length) {
      this.dtmfActive = { event: this.dtmfQueue.shift(), ts: this.ts, packets: 0, endSent: 0 };
      this.stats.dtmfSent++;
    }
    if (this.dtmfActive && this.dtmfPt !== null) {
      const d = this.dtmfActive;
      const ending = d.packets >= 7; // 8 packets x 20 ms = 160 ms tone
      const duration = Math.min((d.packets + 1) * FRAME_SAMPLES, 0xffff);
      const payload = Buffer.from([d.event, (ending ? 0x80 : 0) | 10, (duration >> 8) & 0xff, duration & 0xff]);
      this._sendRtp(this.dtmfPt, d.ts, payload, d.packets === 0);
      if (ending) { d.endSent++; if (d.endSent >= 3) this.dtmfActive = null; } else d.packets++;
      this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
      return;
    }
    if (this.dtmfActive) this.dtmfActive = null; // no telephone-event negotiated

    let pcm;
    if (this.tone) pcm = this._toneFrame();
    else if (frame && !this.muted) pcm = frame;
    else pcm = null;
    const payload = pcm ? g711.encode(this.codec.name, pcm) : Buffer.alloc(FRAME_SAMPLES, g711.SILENCE[this.codec.name] ?? 0xff);
    this._sendRtp(this.codec.pt, this.ts, payload, this.firstPacket);
    this.firstPacket = false;
    this.ts = (this.ts + FRAME_SAMPLES) >>> 0;
  }

  _toneFrame() {
    const out = new Int16Array(FRAME_SAMPLES);
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      out[i] = Math.round(Math.sin(this.tonePhase) * 8000);
      this.tonePhase += (2 * Math.PI * 1000) / 8000; // 1 kHz test tone
    }
    this.tonePhase %= 2 * Math.PI;
    return out;
  }

  _sendRtp(pt, ts, payload, marker) {
    const h = Buffer.alloc(12);
    h[0] = 0x80;
    h[1] = (marker ? 0x80 : 0) | (pt & 0x7f);
    h.writeUInt16BE(this.seq, 2);
    h.writeUInt32BE(ts >>> 0, 4);
    h.writeUInt32BE(this.ssrc, 8);
    this.seq = (this.seq + 1) & 0xffff;
    let pkt = Buffer.concat([h, payload]);
    if (this.srtpTx) pkt = this.srtpTx.protectRtp(pkt);
    this.rtp.send(pkt, this.remote.port, this.remote.address, () => {});
    this.stats.sent++;
    this.stats.sentBytes += payload.length;
  }

  _onRtp(buf, rinfo) {
    let pkt = buf;
    if (pkt.length < 12 || (pkt[0] >> 6) !== 2) return;
    if (this.srtpRx) {
      try { pkt = this.srtpRx.unprotectRtp(pkt); } catch (e) {
        this.stats.srtpAuthFailures++;
        if (this.stats.srtpAuthFailures === 1) this.emit('note', `SRTP: dropping packet from ${rinfo.address}:${rinfo.port}: ${e.message}`);
        return;
      }
    }
    const pt = pkt[1] & 0x7f;
    const seq = pkt.readUInt16BE(2);
    const ts = pkt.readUInt32BE(4);
    this.stats.remoteSsrc = pkt.readUInt32BE(8);
    let off = 12 + 4 * (pkt[0] & 0x0f);
    if (pkt[0] & 0x10) off += 4 + 4 * pkt.readUInt16BE(off + 2);
    let end = pkt.length;
    if (pkt[0] & 0x20) end -= pkt[pkt.length - 1];
    if (off > end) return;
    const payload = pkt.subarray(off, end);
    this.stats.received++;
    this.stats.receivedBytes += payload.length;
    this.stats.lastReceived = Date.now();
    this._updateRxStats(seq, ts);

    if (pt === this.dtmfPt && payload.length >= 4) {
      if (this.rx.lastDtmfTs !== ts) {
        this.rx.lastDtmfTs = ts;
        const digit = DTMF_EVENTS[payload[0]];
        if (digit) { this.stats.dtmfReceived++; this.emit('dtmf', digit); }
      }
      return;
    }
    if (pt !== this.codec.pt && !(pt === 0 || pt === 8)) { this.stats.unknownPt++; return; }
    const name = pt === 0 ? 'PCMU' : pt === 8 ? 'PCMA' : this.codec.name;
    this.emit('audio', g711.decode(name, payload));
  }

  _updateRxStats(seq, ts) {
    const rx = this.rx;
    if (rx.baseSeq === null) { rx.baseSeq = seq; rx.maxSeq = seq; }
    else {
      const delta = (seq - rx.maxSeq) & 0xffff;
      if (delta < 0x8000 && delta > 0) {
        if (seq < rx.maxSeq) rx.cycles += 0x10000;
        rx.maxSeq = seq;
      }
    }
    // Interarrival jitter, RFC 3550 6.4.1 / A.8 (in timestamp units = 1/8000 s).
    const arrival = Math.floor((Number(process.hrtime.bigint() / 1000n) * 8) / 1000);
    const transit = arrival - ts;
    if (rx.transit !== null) {
      let d = transit - rx.transit;
      if (d < 0) d = -d;
      if (d < 8000 * 10) rx.jitter += (d - rx.jitter) / 16;
    }
    rx.transit = transit;
    const expected = rx.cycles + rx.maxSeq - rx.baseSeq + 1;
    this.stats.lost = Math.max(0, expected - this.stats.received);
    this.stats.jitterMs = +(rx.jitter / 8).toFixed(2);
  }

  // ---- RTCP: SR + SDES(CNAME) compound packets ------------------------------------
  _sendRtcp(bye = false) {
    if (!this.remote) return;
    const now = Date.now();
    const ntpSec = Math.floor(now / 1000) + 2208988800;
    const ntpFrac = Math.floor(((now % 1000) / 1000) * 0x100000000);
    const haveRx = this.stats.received > 0 && this.stats.remoteSsrc !== null;
    const sr = Buffer.alloc(28 + (haveRx ? 24 : 0));
    sr[0] = 0x80 | (haveRx ? 1 : 0);
    sr[1] = 200;
    sr.writeUInt16BE(sr.length / 4 - 1, 2);
    sr.writeUInt32BE(this.ssrc, 4);
    sr.writeUInt32BE(ntpSec >>> 0, 8);
    sr.writeUInt32BE(ntpFrac >>> 0, 12);
    sr.writeUInt32BE(this.ts >>> 0, 16);
    sr.writeUInt32BE(this.stats.sent >>> 0, 20);
    sr.writeUInt32BE(this.stats.sentBytes >>> 0, 24);
    if (haveRx) {
      const rx = this.rx;
      const expected = rx.cycles + rx.maxSeq - rx.baseSeq + 1;
      const expInt = expected - rx.expectedPrior;
      const recInt = this.stats.received - rx.receivedPrior;
      rx.expectedPrior = expected;
      rx.receivedPrior = this.stats.received;
      const lostInt = expInt - recInt;
      const fraction = expInt <= 0 || lostInt <= 0 ? 0 : Math.min(255, Math.floor((lostInt << 8) / expInt));
      const cumLost = Math.min(0x7fffff, Math.max(0, expected - this.stats.received));
      sr.writeUInt32BE(this.stats.remoteSsrc >>> 0, 28);
      sr.writeUInt32BE(((fraction << 24) | cumLost) >>> 0, 32);
      sr.writeUInt32BE((rx.cycles + rx.maxSeq) >>> 0, 36);
      sr.writeUInt32BE(Math.floor(rx.jitter) >>> 0, 40);
      sr.writeUInt32BE(rx.lastSr >>> 0, 44);
      const dlsr = rx.lastSrTime ? Math.floor(((now - rx.lastSrTime) / 1000) * 65536) : 0;
      sr.writeUInt32BE(dlsr >>> 0, 48);
    }
    const cname = Buffer.from(this.cname);
    const sdesLen = 4 + 2 + cname.length + 1;
    const sdesPadded = Math.ceil(sdesLen / 4) * 4;
    const sdes = Buffer.alloc(4 + sdesPadded);
    sdes[0] = 0x81;
    sdes[1] = 202;
    sdes.writeUInt16BE(sdes.length / 4 - 1, 2);
    sdes.writeUInt32BE(this.ssrc, 4);
    sdes[8] = 1;
    sdes[9] = cname.length;
    cname.copy(sdes, 10);
    const parts = [sr, sdes];
    if (bye) {
      const b = Buffer.alloc(8);
      b[0] = 0x81; b[1] = 203; b.writeUInt16BE(1, 2); b.writeUInt32BE(this.ssrc, 4);
      parts.push(b);
    }
    let pkt = Buffer.concat(parts);
    if (this.srtpTx) pkt = this.srtpTx.protectRtcp(pkt);
    this.rtcp.send(pkt, this.remote.rtcpPort, this.remote.address, () => {});
  }

  _onRtcp(buf) {
    let pkt = buf;
    if (this.srtpRx) {
      try { pkt = this.srtpRx.unprotectRtcp(pkt); } catch { this.stats.srtpAuthFailures++; return; }
    }
    let off = 0;
    while (off + 8 <= pkt.length) {
      const rc = pkt[off] & 0x1f;
      const pt = pkt[off + 1];
      const len = (pkt.readUInt16BE(off + 2) + 1) * 4;
      if (pt === 200 && off + 28 <= pkt.length) {
        this.rx.lastSr = ((pkt.readUInt32BE(off + 8) & 0xffff) << 16 | (pkt.readUInt32BE(off + 12) >>> 16)) >>> 0;
        this.rx.lastSrTime = Date.now();
      }
      if ((pt === 200 || pt === 201) && rc > 0) {
        const rb = off + (pt === 200 ? 28 : 8);
        if (rb + 24 <= pkt.length) {
          const w = pkt.readUInt32BE(rb + 4);
          this.stats.remoteReport = {
            fractionLost: +(((w >>> 24) / 256) * 100).toFixed(1),
            cumulativeLost: w & 0xffffff,
            jitterMs: +(pkt.readUInt32BE(rb + 12) / 8).toFixed(2),
            at: Date.now(),
          };
        }
      }
      if (pt === 203) this.emit('note', 'RTCP BYE received');
      off += len;
    }
  }

  snapshot() {
    return {
      localPort: this.port,
      remote: this.remote ? `${this.remote.address}:${this.remote.port}` : null,
      codec: this.codec.name,
      pt: this.codec.pt,
      dtmfPt: this.dtmfPt,
      direction: this.direction,
      srtp: this.srtpTx ? this.srtpTx.suite : null,
      ssrc: this.ssrc.toString(16).padStart(8, '0'),
      ...this.stats,
      remoteSsrc: this.stats.remoteSsrc !== null ? this.stats.remoteSsrc.toString(16).padStart(8, '0') : null,
    };
  }
}

module.exports = { RtpSession, FRAME_SAMPLES };
