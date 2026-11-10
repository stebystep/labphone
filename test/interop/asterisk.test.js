'use strict';
// Interoperability test against a real Asterisk (see test/interop/asterisk/*.conf).
// Run inside the Linux test container: docker run --rm labphone-linux-test
// or against your own Asterisk with the same config:
//   ASTERISK_HOST=127.0.0.1 ASTERISK_CA=/tmp/asterisk-ca.pem node --test test/interop/asterisk.test.js
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const { SipTransport } = require('../../src/sip/transport');
const { UserAgent } = require('../../src/sip/ua');

const HOST = process.env.ASTERISK_HOST || '127.0.0.1';
const CA = process.env.ASTERISK_CA || '/tmp/asterisk-ca.pem';

const waitFor = (fn, ms = 8000, what = 'condition') => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) { clearInterval(iv); resolve(v); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${what}`)); }
  }, 25);
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rms = (frames) => {
  let s = 0; let n = 0;
  for (const f of frames) for (const x of f) { s += x * x; n++; }
  return n ? Math.sqrt(s / n) : 0;
};

async function phone(ext, port, transport, srtp) {
  const t = new SipTransport({ bindHost: '127.0.0.1', sipPort: port, tlsPort: port + 1 });
  await t.start();
  const ua = new UserAgent({
    transport: t,
    profile: { username: ext, password: `secret${ext}`, domain: HOST, transport, srtp, tlsVerify: true, register: true, expires: 120 },
    tlsClient: { rejectUnauthorized: true, ca: fs.readFileSync(CA) },
    media: { bindHost: '127.0.0.1', portMin: port + 100, portMax: port + 198 },
  });
  const ev = { incoming: [], audio: [], notes: [] };
  ua.on('incoming', (c) => ev.incoming.push(c));
  ua.on('audio', (id, pcm) => ev.audio.push(pcm));
  ua.on('note', (n) => ev.notes.push(n));
  return { ua, t, ev };
}

let p1001; let p1002; let p1003;

before(async () => {
  p1001 = await phone('1001', 15060, 'tls', 'sdes');
  p1002 = await phone('1002', 16060, 'tls', 'sdes');
  p1003 = await phone('1003', 17060, 'udp', 'off');
});

after(async () => {
  for (const p of [p1001, p1002, p1003]) { await p.ua.stop(); await p.t.stop(); }
});

test('register 1001 and 1002 over TLS (certificate verified) and 1003 over UDP', async () => {
  for (const p of [p1001, p1002, p1003]) {
    await p.ua.register();
    assert.equal(p.ua.reg.state, 'registered', `${p.ua.profile.username}: ${p.ua.reg.reason}\n${p.ev.notes.join('\n')}`);
  }
  const tls = p1001.ua.reg.connection.tls;
  assert.equal(tls.authorized, true, tls.authError);
  assert.match(tls.subject, /pbx\.lab\.test/);
  assert.equal(p1001.ua.reg.server, 'Asterisk-Lab-PBX');
});

async function callAndWait(p, target) {
  const call = await p.ua.call(target);
  await waitFor(() => p.ua.calls.get(call.id).state === 'active', 8000, `${target} answered`);
  return p.ua.calls.get(call.id);
}

test('TLS + SRTP call to the Asterisk echo test: our tone comes back decrypted', async () => {
  const c = await callAndWait(p1001, '600');
  assert.equal(c.transport, 'tls');
  assert.match(c.srtpSuite, /^AES_CM_128_HMAC_SHA1_(80|32)$/);
  p1001.ev.audio.length = 0;
  p1001.ua.setTone(c.id, true);
  await sleep(1500);
  const echoed = rms(p1001.ev.audio.slice(-20));
  const stats = p1001.ua.mediaStats()[c.id];
  console.log(`  echo: suite=${c.srtpSuite} codec=${c.codec.name} sent=${stats.sent} recv=${stats.received} authFail=${stats.srtpAuthFailures} rms=${echoed.toFixed(0)} jitter=${stats.jitterMs}ms`);
  assert.equal(stats.srtpAuthFailures, 0);
  assert.ok(echoed > 2000, `expected echoed tone, rms=${echoed}`);
  p1001.ua.hangup(c.id);
  await waitFor(() => c.state === 'ended', 3000, 'hangup');
});

test('RFC 4733 DTMF digits 1-2-3 recognised by an Asterisk IVR', async () => {
  const c = await callAndWait(p1001, '601');
  await sleep(500);
  for (const d of '123') { await p1001.ua.sendDtmf(c.id, d); await sleep(400); }
  await sleep(800);
  p1001.ev.audio.length = 0;
  p1001.ua.setTone(c.id, true);
  await sleep(1200);
  assert.notEqual(c.state, 'ended', 'Asterisk hung up: DTMF 123 was not recognised');
  assert.ok(rms(p1001.ev.audio.slice(-20)) > 2000, 'after DTMF 123 the call should echo');
  p1001.ua.hangup(c.id);
});

test('1001 -> Asterisk -> 1002: incoming call over the registered TLS connection, hold, BYE', async () => {
  const n = p1002.ev.incoming.length;
  const call = await p1001.ua.call('1002');
  const inc = await waitFor(() => p1002.ev.incoming[n], 8000, '1002 rings');
  assert.equal(inc.transport, 'tls');
  assert.ok(inc.srtp, 'Asterisk should offer SRTP to 1002');
  await p1002.ua.answer(inc.id);
  await waitFor(() => p1001.ua.calls.get(call.id).state === 'active', 8000, '1001 connected');

  p1002.ev.audio.length = 0;
  p1001.ua.setTone(call.id, true);
  await sleep(1200);
  assert.ok(rms(p1002.ev.audio.slice(-20)) > 2000, 'tone from 1001 should reach 1002 through Asterisk');
  p1001.ua.setTone(call.id, false);

  await p1001.ua.hold(call.id, true);
  assert.equal(p1001.ua.calls.get(call.id).localHold, true);
  assert.match(p1001.ua.calls.get(call.id).statusText, /On hold/);
  await p1001.ua.hold(call.id, false);
  assert.equal(p1001.ua.calls.get(call.id).statusText, 'Connected');

  p1002.ua.hangup(inc.id);
  await waitFor(() => p1001.ua.calls.get(call.id).state === 'ended', 5000, 'BYE relayed to 1001');
});

test('plain UDP phone 1003 calls the echo test (RTP unencrypted)', async () => {
  const c = await callAndWait(p1003, '600');
  assert.equal(c.transport, 'udp');
  assert.equal(c.srtpSuite, null);
  p1003.ev.audio.length = 0;
  p1003.ua.setTone(c.id, true);
  await sleep(1200);
  assert.ok(rms(p1003.ev.audio.slice(-20)) > 2000);
  p1003.ua.hangup(c.id);
});

test('SRTP phone 1001 calls plain phone 1003: Asterisk bridges SRTP <-> RTP', async () => {
  const n = p1003.ev.incoming.length;
  const call = await p1001.ua.call('1003');
  const inc = await waitFor(() => p1003.ev.incoming[n], 8000, '1003 rings');
  assert.equal(inc.srtp, null);
  await p1003.ua.answer(inc.id);
  await waitFor(() => p1001.ua.calls.get(call.id).state === 'active', 8000, 'connected');
  p1003.ev.audio.length = 0;
  p1001.ua.setTone(call.id, true);
  await sleep(1200);
  assert.ok(rms(p1003.ev.audio.slice(-20)) > 2000);
  p1001.ua.hangup(call.id);
  await waitFor(() => p1003.ua.calls.get(inc.id).state === 'ended', 5000, '1003 released');
});

test('unregister', async () => {
  for (const p of [p1001, p1002, p1003]) {
    await p.ua.unregister();
    assert.equal(p.ua.reg.state, 'unregistered');
  }
});
