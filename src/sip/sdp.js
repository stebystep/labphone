'use strict';
// SDP (RFC 4566) builder/parser and the offer/answer rules (RFC 3264) for one audio stream.
// SRTP keys are carried with SDES "a=crypto" lines (RFC 4568).

const STATIC_PT = { 0: 'PCMU', 8: 'PCMA', 9: 'G722', 18: 'G729', 3: 'GSM' };
const SUPPORTED_CODECS = { PCMU: 0, PCMA: 8 };
const SUPPORTED_SUITES = ['AES_CM_128_HMAC_SHA1_80', 'AES_CM_128_HMAC_SHA1_32'];

function buildSdp({ sessionId, sessionVersion, ip, port, codecs, dtmfPt, crypto, direction = 'sendrecv' }) {
  const ipv = ip.includes(':') ? 'IP6' : 'IP4';
  const proto = crypto && crypto.length ? 'RTP/SAVP' : 'RTP/AVP';
  const pts = codecs.map((c) => c.pt);
  if (dtmfPt !== null && dtmfPt !== undefined) pts.push(dtmfPt);
  const lines = [
    'v=0',
    `o=labphone ${sessionId} ${sessionVersion} IN ${ipv} ${ip}`,
    's=LabPhone',
    `c=IN ${ipv} ${ip}`,
    't=0 0',
    `m=audio ${port} ${proto} ${pts.join(' ')}`,
  ];
  for (const c of codecs) lines.push(`a=rtpmap:${c.pt} ${c.name}/8000`);
  if (dtmfPt !== null && dtmfPt !== undefined) {
    lines.push(`a=rtpmap:${dtmfPt} telephone-event/8000`, `a=fmtp:${dtmfPt} 0-16`);
  }
  for (const c of crypto || []) lines.push(`a=crypto:${c.tag} ${c.suite} inline:${c.key}`);
  lines.push('a=ptime:20', `a=${direction}`);
  return `${lines.join('\r\n')}\r\n`;
}

function parseSdp(text) {
  const session = { origin: null, connection: null, media: [], direction: null };
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length < 2 || line[1] !== '=') continue;
    const type = line[0];
    const value = line.slice(2);
    if (type === 'o') {
      const p = value.split(/\s+/);
      session.origin = { username: p[0], sessionId: p[1], version: p[2], address: p[5] };
    } else if (type === 'c') {
      const p = value.split(/\s+/);
      const addr = p[2] ? p[2].split('/')[0] : null;
      if (cur) cur.connection = addr; else session.connection = addr;
    } else if (type === 'm') {
      const p = value.split(/\s+/);
      cur = {
        type: p[0], port: parseInt(p[1], 10), proto: p[2], fmts: p.slice(3).map((x) => parseInt(x, 10)),
        rtpmap: {}, fmtp: {}, crypto: [], direction: null, rtcpPort: null, connection: null, ptime: null,
      };
      session.media.push(cur);
    } else if (type === 'a') {
      const colon = value.indexOf(':');
      const name = colon >= 0 ? value.slice(0, colon) : value;
      const arg = colon >= 0 ? value.slice(colon + 1) : '';
      if (['sendrecv', 'sendonly', 'recvonly', 'inactive'].includes(name)) {
        if (cur) cur.direction = name; else session.direction = name;
      } else if (!cur) {
        continue;
      } else if (name === 'rtpmap') {
        const m = /^(\d+)\s+([^/]+)\/(\d+)/.exec(arg);
        if (m) cur.rtpmap[parseInt(m[1], 10)] = { name: m[2], rate: parseInt(m[3], 10) };
      } else if (name === 'fmtp') {
        const m = /^(\d+)\s+(.*)$/.exec(arg);
        if (m) cur.fmtp[parseInt(m[1], 10)] = m[2];
      } else if (name === 'crypto') {
        const m = /^(\d+)\s+(\S+)\s+inline:([^|\s]+)(\S*)\s*(.*)$/.exec(arg);
        if (m) cur.crypto.push({ tag: parseInt(m[1], 10), suite: m[2], key: m[3], lifetimeMki: m[4], sessionParams: m[5] });
      } else if (name === 'rtcp') {
        cur.rtcpPort = parseInt(arg, 10);
      } else if (name === 'ptime') {
        cur.ptime = parseInt(arg, 10);
      }
    }
  }
  for (const m of session.media) {
    if (!m.connection) m.connection = session.connection;
    if (!m.direction) m.direction = session.direction || 'sendrecv';
  }
  return session;
}

function codecName(media, pt) {
  if (media.rtpmap[pt]) return media.rtpmap[pt].name.toUpperCase();
  return STATIC_PT[pt] || null;
}

function findDtmfPt(media) {
  for (const pt of media.fmts) {
    const r = media.rtpmap[pt];
    if (r && r.name.toLowerCase() === 'telephone-event' && r.rate === 8000) return pt;
  }
  return null;
}

function audioMedia(sdp) {
  return sdp.media.find((m) => m.type === 'audio' && m.port !== 0) || null;
}

// Choose a codec. When answering we honour the offerer's order (RFC 3264 6.1),
// restricted to what we support and have enabled.
function chooseCodec(media, enabled) {
  for (const pt of media.fmts) {
    const name = codecName(media, pt);
    if (name && SUPPORTED_CODECS[name] !== undefined && enabled.includes(name)) return { pt, name };
  }
  return null;
}

// A usable crypto line: supported suite, no MKI, and a 30 byte key+salt.
function chooseCrypto(media) {
  for (const c of media.crypto) {
    if (!SUPPORTED_SUITES.includes(c.suite)) continue;
    if (/\|\d+:\d+/.test(c.lifetimeMki)) continue; // MKI not supported
    if (Buffer.from(c.key, 'base64').length !== 30) continue;
    return c;
  }
  return null;
}

function answerDirection(offered) {
  return { sendonly: 'recvonly', recvonly: 'sendonly', inactive: 'inactive' }[offered] || 'sendrecv';
}

module.exports = {
  buildSdp, parseSdp, audioMedia, chooseCodec, chooseCrypto, findDtmfPt, codecName, answerDirection,
  SUPPORTED_CODECS, SUPPORTED_SUITES,
};
