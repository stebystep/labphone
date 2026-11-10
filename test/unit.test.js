'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parse, parseUri, parseNameAddr, parseVia, StreamParser, SipMessage } = require('../src/sip/message');
const digest = require('../src/sip/digest');
const sdp = require('../src/sip/sdp');
const g711 = require('../src/media/g711');
const { SrtpContext, deriveKey, generateKey } = require('../src/media/srtp');

test('parses compact headers, folding and multi-value Via', () => {
  const raw = [
    'INVITE sip:bob@example.com SIP/2.0',
    'v: SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK1, SIP/2.0/TLS proxy.example.com;branch=z9hG4bK2',
    'f: "Alice, A." <sip:alice@example.com>;tag=abc',
    't: <sip:bob@example.com>',
    'i: 123@host',
    'CSeq: 7 INVITE',
    'Subject: a long',
    '  folded subject',
    'l: 4',
    '',
    'body+extra',
  ].join('\r\n');
  const m = parse(raw);
  assert.equal(m.method, 'INVITE');
  assert.equal(m.getAll('Via').length, 2);
  assert.equal(m.topVia.params.branch, 'z9hG4bK1');
  assert.equal(m.from.display, 'Alice, A.');
  assert.equal(m.from.params.tag, 'abc');
  assert.equal(m.callId, '123@host');
  assert.deepEqual(m.cseq, { seq: 7, method: 'INVITE' });
  assert.equal(m.get('Subject'), 'a long folded subject');
  assert.equal(m.body, 'body');
  assert.match(m.toString(), /Content-Length: 4\r\n\r\nbody$/);
});

test('parses URIs with params, IPv6 and sips', () => {
  const u = parseUri('sips:alice:pw@[2001:db8::1]:5061;transport=tls;lr?subject=x');
  assert.equal(u.scheme, 'sips');
  assert.equal(u.user, 'alice');
  assert.equal(u.host, '[2001:db8::1]');
  assert.equal(u.port, 5061);
  assert.equal(u.params.transport, 'tls');
  assert.equal(u.params.lr, null);
  assert.equal(parseNameAddr('sip:x@y;tag=1').params.tag, '1');
  assert.equal(parseVia('SIP/2.0/TLS 1.2.3.4:5061;branch=z9hG4bKx;rport').transport, 'TLS');
});

test('stream parser splits TCP byte stream and answers keep-alive pings', () => {
  const got = [];
  let pings = 0;
  const p = new StreamParser({ onMessage: (b) => got.push(parse(b)), onPing: () => pings++ });
  const msg = 'OPTIONS sip:a@b SIP/2.0\r\nCall-ID: 1\r\nContent-Length: 2\r\n\r\nhi';
  const all = Buffer.from(`\r\n\r\n${msg}${msg}`);
  for (let i = 0; i < all.length; i += 7) p.push(all.subarray(i, i + 7));
  assert.equal(got.length, 2);
  assert.equal(got[1].body, 'hi');
  assert.equal(pings, 1);
});

test('digest response matches RFC 2617 example', () => {
  const r = digest.computeResponse({
    algorithm: 'MD5', realm: 'testrealm@host.com', nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    method: 'GET', uri: '/dir/index.html', username: 'Mufasa', password: 'Circle Of Life',
    qop: 'auth', nc: '00000001', cnonce: '0a4f113b',
  });
  assert.equal(r, '6629fae49393a05397450978507c4ef1');
});

test('digest prefers SHA-256 and round-trips through verify', () => {
  const ch = digest.pickChallenge(['Digest realm="r", nonce="n1", algorithm=MD5, qop="auth"', 'Digest realm="r", nonce="n2", algorithm=SHA-256, qop="auth"']);
  assert.equal(ch.algorithm, 'SHA-256');
  const auth = digest.buildAuthorization({ challenge: ch, method: 'REGISTER', uri: 'sip:r', username: 'u', password: 'p' });
  assert.ok(digest.verifyAuthorization(auth, { method: 'REGISTER', password: 'p', realm: 'r' }));
  assert.ok(!digest.verifyAuthorization(auth, { method: 'REGISTER', password: 'wrong', realm: 'r' }));
});

test('SRTP key derivation matches RFC 3711 B.3 test vectors', () => {
  const key = Buffer.from('E1F97A0D3E018BE0D64FA32C06DE4139', 'hex');
  const salt = Buffer.from('0EC675AD498AFEEBB6960B3AABE6', 'hex');
  assert.equal(deriveKey(key, salt, 0, 16).toString('hex').toUpperCase(), 'C61E7A93744F39EE10734AFE3FF7A087');
  assert.equal(deriveKey(key, salt, 2, 14).toString('hex').toUpperCase(), '30CBBC08863D8C85D49DB34A9AE1');
  assert.equal(deriveKey(key, salt, 1, 20).toString('hex').toUpperCase(), 'CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4');
});

function rtp(seq, ts, ssrc, payload) {
  const h = Buffer.alloc(12);
  h[0] = 0x80; h[1] = 0; h.writeUInt16BE(seq, 2); h.writeUInt32BE(ts, 4); h.writeUInt32BE(ssrc, 8);
  return Buffer.concat([h, payload]);
}

for (const suite of ['AES_CM_128_HMAC_SHA1_80', 'AES_CM_128_HMAC_SHA1_32']) {
  test(`SRTP ${suite}: protect/unprotect, tamper, replay, rollover`, () => {
    const key = generateKey();
    const tx = new SrtpContext(suite, key);
    const rx = new SrtpContext(suite, key);
    const payload = Buffer.from('hello secure world');
    let seq = 65530;
    for (let i = 0; i < 12; i++) { // crosses the 16-bit sequence wrap -> ROC must increment
      const plain = rtp(seq, i * 160, 0x1234, payload);
      const enc = tx.protectRtp(plain);
      assert.equal(enc.length, plain.length + (suite.endsWith('80') ? 10 : 4));
      assert.notDeepEqual(enc.subarray(12, 12 + payload.length), payload);
      assert.deepEqual(rx.unprotectRtp(enc), plain);
      seq = (seq + 1) & 0xffff;
    }
    const enc = tx.protectRtp(rtp(seq, 0, 0x1234, payload));
    const bad = Buffer.from(enc);
    bad[15] ^= 1;
    assert.throws(() => rx.unprotectRtp(bad), /authentication failed/);
    rx.unprotectRtp(enc);
    assert.throws(() => rx.unprotectRtp(enc), /replay/);

    const rtcp = Buffer.alloc(28); rtcp[0] = 0x80; rtcp[1] = 200; rtcp.writeUInt16BE(6, 2); rtcp.writeUInt32BE(0x1234, 4);
    rtcp.write('sender report body', 8);
    assert.deepEqual(rx.unprotectRtcp(tx.protectRtcp(rtcp)), rtcp);
  });
}

test('SDP offer/answer: codec order, telephone-event, crypto, hold', () => {
  const offer = sdp.buildSdp({
    sessionId: 1, sessionVersion: 1, ip: '10.0.0.1', port: 40000,
    codecs: [{ pt: 8, name: 'PCMA' }, { pt: 0, name: 'PCMU' }], dtmfPt: 101,
    crypto: [{ tag: 1, suite: 'AES_CM_128_HMAC_SHA1_80', key: generateKey() }], direction: 'sendonly',
  });
  const m = sdp.audioMedia(sdp.parseSdp(offer));
  assert.equal(m.proto, 'RTP/SAVP');
  assert.equal(m.connection, '10.0.0.1');
  assert.deepEqual(sdp.chooseCodec(m, ['PCMU', 'PCMA']), { pt: 8, name: 'PCMA' });
  assert.equal(sdp.chooseCodec(m, ['PCMU']).name, 'PCMU');
  assert.equal(sdp.findDtmfPt(m), 101);
  assert.equal(sdp.chooseCrypto(m).tag, 1);
  assert.equal(sdp.answerDirection(m.direction), 'recvonly');
});

test('G.711 round-trip stays within companding error', () => {
  for (const name of ['PCMU', 'PCMA']) {
    const pcm = Int16Array.from({ length: 160 }, (_, i) => Math.round(Math.sin(i / 5) * 12000));
    const back = g711.decode(name, g711.encode(name, pcm));
    for (let i = 0; i < pcm.length; i++) assert.ok(Math.abs(back[i] - pcm[i]) <= Math.max(16, Math.abs(pcm[i]) * 0.07), `${name} sample ${i}`);
  }
  assert.equal(g711.linearToUlaw(0), 0xff);
  assert.equal(g711.linearToAlaw(0), 0xd5);
});

test('responses serialize with a correct Content-Length for UTF-8 bodies', () => {
  const r = SipMessage.response(200);
  r.body = 'olá';
  assert.match(r.toString(), /Content-Length: 4/);
});
