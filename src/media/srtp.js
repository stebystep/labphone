'use strict';
// SRTP / SRTCP (RFC 3711) with AES-CM-128 encryption and HMAC-SHA1 authentication.
// Suites: AES_CM_128_HMAC_SHA1_80 and AES_CM_128_HMAC_SHA1_32 (RFC 4568 key exchange).
const crypto = require('crypto');

const SUITES = {
  AES_CM_128_HMAC_SHA1_80: { rtpTagLen: 10, rtcpTagLen: 10 },
  AES_CM_128_HMAC_SHA1_32: { rtpTagLen: 4, rtcpTagLen: 10 },
};

const LABEL = { RTP_ENC: 0, RTP_AUTH: 1, RTP_SALT: 2, RTCP_ENC: 3, RTCP_AUTH: 4, RTCP_SALT: 5 };

function aesCm(key, iv, data) {
  const c = crypto.createCipheriv('aes-128-ctr', key, iv);
  return Buffer.concat([c.update(data), c.final()]);
}

// RFC 3711 4.3.1 key derivation with key_derivation_rate = 0 (r = 0).
// x = key_id XOR master_salt, where key_id = label || r (7 bytes, right aligned in 14 bytes).
function deriveKey(masterKey, masterSalt, label, length) {
  const iv = Buffer.alloc(16);
  masterSalt.copy(iv, 0, 0, 14);
  iv[7] ^= label;
  return aesCm(masterKey, iv, Buffer.alloc(length));
}

function deriveSessionKeys(masterKey, masterSalt) {
  return {
    rtpEnc: deriveKey(masterKey, masterSalt, LABEL.RTP_ENC, 16),
    rtpAuth: deriveKey(masterKey, masterSalt, LABEL.RTP_AUTH, 20),
    rtpSalt: deriveKey(masterKey, masterSalt, LABEL.RTP_SALT, 14),
    rtcpEnc: deriveKey(masterKey, masterSalt, LABEL.RTCP_ENC, 16),
    rtcpAuth: deriveKey(masterKey, masterSalt, LABEL.RTCP_AUTH, 20),
    rtcpSalt: deriveKey(masterKey, masterSalt, LABEL.RTCP_SALT, 14),
  };
}

// IV = (k_s * 2^16) XOR (SSRC * 2^64) XOR (index * 2^16)   (RFC 3711 4.1.1)
function buildIv(salt, ssrc, index) {
  const iv = Buffer.alloc(16);
  salt.copy(iv, 0, 0, 14);
  iv[4] ^= (ssrc >>> 24) & 0xff;
  iv[5] ^= (ssrc >>> 16) & 0xff;
  iv[6] ^= (ssrc >>> 8) & 0xff;
  iv[7] ^= ssrc & 0xff;
  const hi = Math.floor(index / 0x100000000) & 0xffff;
  const lo = index >>> 0;
  iv[8] ^= (hi >>> 8) & 0xff;
  iv[9] ^= hi & 0xff;
  iv[10] ^= (lo >>> 24) & 0xff;
  iv[11] ^= (lo >>> 16) & 0xff;
  iv[12] ^= (lo >>> 8) & 0xff;
  iv[13] ^= lo & 0xff;
  return iv;
}

function rtpHeaderLength(pkt) {
  if (pkt.length < 12) return -1;
  const cc = pkt[0] & 0x0f;
  let len = 12 + 4 * cc;
  if (pkt[0] & 0x10) {
    if (pkt.length < len + 4) return -1;
    len += 4 + 4 * pkt.readUInt16BE(len + 2);
  }
  return len <= pkt.length ? len : -1;
}

function hmac(key, ...parts) {
  const h = crypto.createHmac('sha1', key);
  for (const p of parts) h.update(p);
  return h.digest();
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

class SrtpError extends Error {}

// One SrtpContext per direction: the sender uses our key, the receiver uses the peer's key.
class SrtpContext {
  constructor(suite, keyBase64OrBuffer) {
    if (!SUITES[suite]) throw new SrtpError(`unsupported SRTP suite ${suite}`);
    const material = Buffer.isBuffer(keyBase64OrBuffer) ? keyBase64OrBuffer : Buffer.from(keyBase64OrBuffer, 'base64');
    if (material.length !== 30) throw new SrtpError('SRTP key material must be 30 bytes (16 key + 14 salt)');
    this.suite = suite;
    this.params = SUITES[suite];
    this.keys = deriveSessionKeys(material.subarray(0, 16), material.subarray(16, 30));
    this.streams = new Map(); // ssrc -> { roc, s_l, init, replay:Set }
    this.srtcpIndex = 0;
    this.rtcpReplay = new Set();
  }

  stream(ssrc) {
    let s = this.streams.get(ssrc);
    if (!s) { s = { roc: 0, s_l: 0, init: false, maxIndex: -1, seen: new Set() }; this.streams.set(ssrc, s); }
    return s;
  }

  protectRtp(pkt) {
    const hl = rtpHeaderLength(pkt);
    if (hl < 0) throw new SrtpError('bad RTP header');
    const seq = pkt.readUInt16BE(2);
    const ssrc = pkt.readUInt32BE(8);
    const st = this.stream(ssrc);
    if (st.init && seq < st.s_l && st.s_l - seq > 0x8000) st.roc = (st.roc + 1) >>> 0; // sequence wrapped
    st.s_l = seq;
    st.init = true;
    const index = st.roc * 0x10000 + seq;
    const enc = aesCm(this.keys.rtpEnc, buildIv(this.keys.rtpSalt, ssrc, index), pkt.subarray(hl));
    const out = Buffer.concat([pkt.subarray(0, hl), enc]);
    const tag = hmac(this.keys.rtpAuth, out, u32(st.roc)).subarray(0, this.params.rtpTagLen);
    return Buffer.concat([out, tag]);
  }

  unprotectRtp(pkt) {
    const tagLen = this.params.rtpTagLen;
    const body = pkt.subarray(0, pkt.length - tagLen);
    const hl = rtpHeaderLength(body);
    if (hl < 0) throw new SrtpError('bad SRTP header');
    const seq = body.readUInt16BE(2);
    const ssrc = body.readUInt32BE(8);
    const st = this.stream(ssrc);
    if (!st.init) { st.s_l = seq; }
    // Index estimation, RFC 3711 3.3.1 / Appendix A.
    let v;
    if (st.s_l < 0x8000) v = seq - st.s_l > 0x8000 ? st.roc - 1 : st.roc;
    else v = st.s_l - 0x8000 > seq ? st.roc + 1 : st.roc;
    if (v < 0) throw new SrtpError('packet before start of stream');
    const index = v * 0x10000 + seq;

    const expected = hmac(this.keys.rtpAuth, body, u32(v)).subarray(0, tagLen);
    if (!crypto.timingSafeEqual(expected, pkt.subarray(pkt.length - tagLen))) throw new SrtpError('SRTP authentication failed');
    if (st.seen.has(index) || (st.maxIndex - index) >= 128) throw new SrtpError('SRTP replay');

    const dec = aesCm(this.keys.rtpEnc, buildIv(this.keys.rtpSalt, ssrc, index), body.subarray(hl));
    // Update replay window and rollover state only after successful authentication.
    st.seen.add(index);
    if (index > st.maxIndex) {
      st.maxIndex = index;
      for (const i of st.seen) if (st.maxIndex - i >= 128) st.seen.delete(i);
    }
    if (!st.init) { st.init = true; st.roc = v; st.s_l = seq; } else if (v === st.roc + 1) { st.roc = v; st.s_l = seq; } else if (v === st.roc && seq > st.s_l) { st.s_l = seq; }
    return Buffer.concat([body.subarray(0, hl), dec]);
  }

  protectRtcp(pkt) {
    if (pkt.length < 8) throw new SrtpError('bad RTCP packet');
    const ssrc = pkt.readUInt32BE(4);
    const index = this.srtcpIndex;
    this.srtcpIndex = (this.srtcpIndex + 1) & 0x7fffffff;
    const enc = aesCm(this.keys.rtcpEnc, buildIv(this.keys.rtcpSalt, ssrc, index), pkt.subarray(8));
    const out = Buffer.concat([pkt.subarray(0, 8), enc, u32((0x80000000 | index) >>> 0)]);
    const tag = hmac(this.keys.rtcpAuth, out).subarray(0, this.params.rtcpTagLen);
    return Buffer.concat([out, tag]);
  }

  unprotectRtcp(pkt) {
    const tagLen = this.params.rtcpTagLen;
    if (pkt.length < 8 + 4 + tagLen) throw new SrtpError('short SRTCP packet');
    const authed = pkt.subarray(0, pkt.length - tagLen);
    const expected = hmac(this.keys.rtcpAuth, authed).subarray(0, tagLen);
    if (!crypto.timingSafeEqual(expected, pkt.subarray(pkt.length - tagLen))) throw new SrtpError('SRTCP authentication failed');
    const eIndex = authed.readUInt32BE(authed.length - 4);
    const index = eIndex & 0x7fffffff;
    if (this.rtcpReplay.has(index)) throw new SrtpError('SRTCP replay');
    this.rtcpReplay.add(index);
    if (this.rtcpReplay.size > 256) this.rtcpReplay.delete(this.rtcpReplay.values().next().value);
    const payload = authed.subarray(8, authed.length - 4);
    const ssrc = authed.readUInt32BE(4);
    const dec = eIndex & 0x80000000 ? aesCm(this.keys.rtcpEnc, buildIv(this.keys.rtcpSalt, ssrc, index), payload) : payload;
    return Buffer.concat([authed.subarray(0, 8), dec]);
  }
}

function generateKey() {
  return crypto.randomBytes(30).toString('base64');
}

module.exports = { SrtpContext, SrtpError, SUITES, deriveSessionKeys, deriveKey, buildIv, generateKey, rtpHeaderLength };
