'use strict';
// End-to-end tests: real sockets on 127.0.0.1, three phones + a digest registrar.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { SipTransport } = require('../src/sip/transport');
const { UserAgent } = require('../src/sip/ua');
const { ensureSelfSigned } = require('../src/certs');
const { TestRegistrar } = require('./helpers/registrar');

const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labphone-test-'));
const tlsCreds = ensureSelfSigned(certDir);
const base = 20000 + Math.floor(Math.random() * 20000);

const waitFor = (fn, ms = 5000, what = 'condition') => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    let v;
    try { v = fn(); } catch { v = false; }
    if (v) { clearInterval(iv); resolve(v); } else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${what}`)); }
  }, 20);
});

async function phone(name, offset, profile = {}) {
  const transport = new SipTransport({ bindHost: '127.0.0.1', sipPort: base + offset, tlsPort: base + offset + 1, tlsServer: tlsCreds });
  await transport.start();
  const ua = new UserAgent({
    transport,
    profile: { name, username: name, password: `${name}-pw`, domain: '127.0.0.1', proxy: `127.0.0.1:${base + 1}`, transport: 'tls', register: false, ...profile },
    tlsClient: { rejectUnauthorized: false },
    media: { bindHost: '127.0.0.1', portMin: base + 1000 + offset * 20, portMax: base + 1000 + offset * 20 + 18 },
  });
  const events = { incoming: [], dtmf: [], audio: [], ended: [], notes: [] };
  ua.on('incoming', (c) => events.incoming.push(c));
  ua.on('dtmf', (id, d) => events.dtmf.push(d));
  ua.on('audio', (id, pcm) => events.audio.push(pcm));
  ua.on('call-ended', (c) => events.ended.push(c));
  ua.on('note', (n) => events.notes.push(n));
  return { ua, transport, events, uri: (t = 'tls') => `sip:${name}@127.0.0.1:${t === 'tls' ? base + offset + 1 : base + offset};transport=${t}` };
}

function rms(frames) {
  let sum = 0; let n = 0;
  for (const f of frames) for (const s of f) { sum += s * s; n++; }
  return n ? Math.sqrt(sum / n) : 0;
}

let registrar; let alice; let bob; let carol;

before(async () => {
  registrar = new TestRegistrar({ sipPort: base, tlsPort: base + 1, tls: tlsCreds, users: { alice: 'alice-pw', bob: 'bob-pw' } });
  await registrar.start();
  alice = await phone('alice', 10);
  bob = await phone('bob', 20);
  carol = await phone('carol', 30, { srtp: 'sdes' });
});

after(async () => {
  for (const p of [alice, bob, carol]) { await p.ua.stop(); await p.transport.stop(); }
  await registrar.stop();
  fs.rmSync(certDir, { recursive: true, force: true });
});

for (const transport of ['udp', 'tcp', 'tls']) {
  test(`REGISTER with digest auth over ${transport.toUpperCase()}`, async () => {
    alice.ua.profile.transport = transport;
    alice.ua.profile.proxy = `127.0.0.1:${transport === 'tls' ? base + 1 : base}`;
    await alice.ua.register();
    assert.equal(alice.ua.reg.state, 'registered', alice.ua.reg.reason);
    assert.equal(alice.ua.reg.expires, 120);
    const last = registrar.log[registrar.log.length - 1];
    assert.equal(last.src.transport, transport);
    assert.match(last.req.get('Authorization'), /^Digest username="alice"/);
    if (transport === 'tls') assert.ok(alice.ua.reg.connection.tls.protocol.startsWith('TLS'));
    await alice.ua.unregister();
    assert.equal(alice.ua.reg.state, 'unregistered');
  });
}

test('wrong password fails registration', async () => {
  alice.ua.profile.password = 'nope';
  alice.ua.profile.register = false;
  await alice.ua.register();
  assert.equal(alice.ua.reg.state, 'failed');
  assert.match(alice.ua.reg.reason, /^401/);
  alice.ua.profile.password = 'alice-pw';
});

test('TLS + SRTP call: audio, DTMF, hold, hangup', async () => {
  // From here on the phones call each other directly (IP-to-IP, no outbound proxy).
  for (const p of [alice, bob, carol]) { p.ua.profile.proxy = ''; p.ua.profile.domain = ''; }
  alice.ua.profile.transport = 'tls';
  alice.ua.profile.srtp = 'sdes';
  const call = await alice.ua.call(bob.uri('tls'));
  const inc = await waitFor(() => bob.events.incoming[bob.events.incoming.length - 1], 5000, 'incoming call');
  await bob.ua.answer(inc.id);
  await waitFor(() => alice.ua.calls.get(call.id).state === 'active', 5000, 'alice active');

  const a = alice.ua.calls.get(call.id).snapshot();
  const b = bob.ua.calls.get(inc.id).snapshot();
  assert.equal(a.transport, 'tls');
  assert.equal(b.transport, 'tls');
  assert.equal(a.srtp, 'AES_CM_128_HMAC_SHA1_80');
  assert.equal(b.srtp, 'AES_CM_128_HMAC_SHA1_80');
  assert.equal(a.keysExposed, false);

  // 1 kHz test tone from alice must arrive (decrypted) at bob.
  bob.events.audio.length = 0;
  alice.ua.setTone(call.id, true);
  await new Promise((r) => setTimeout(r, 600));
  alice.ua.setTone(call.id, false);
  assert.ok(rms(bob.events.audio.slice(-10)) > 3000, `bob should hear the tone, rms=${rms(bob.events.audio.slice(-10))}`);
  const bobStats = bob.ua.mediaStats()[inc.id];
  assert.equal(bobStats.srtpAuthFailures, 0);
  assert.ok(bobStats.received > 20);

  alice.ua.sendDtmf(call.id, '5');
  alice.ua.sendDtmf(call.id, '#');
  await waitFor(() => bob.events.dtmf.join('') === '5#', 3000, 'DTMF 5#');

  await alice.ua.hold(call.id, true);
  await waitFor(() => bob.ua.calls.get(inc.id).remoteHold, 3000, 'bob sees hold');
  assert.equal(alice.ua.calls.get(call.id).localHold, true);
  await alice.ua.hold(call.id, false);
  await waitFor(() => !bob.ua.calls.get(inc.id).remoteHold, 3000, 'bob sees resume');
  // Keys survive the re-INVITE: audio still flows without auth failures.
  const before = bob.ua.mediaStats()[inc.id].received;
  await new Promise((r) => setTimeout(r, 300));
  assert.ok(bob.ua.mediaStats()[inc.id].received > before + 5);
  assert.equal(bob.ua.mediaStats()[inc.id].srtpAuthFailures, 0);

  bob.ua.hangup(inc.id);
  await waitFor(() => alice.ua.calls.get(call.id).state === 'ended', 3000, 'alice ended');
  assert.equal(alice.ua.calls.get(call.id).endReason, 'Remote hangup');
  alice.ua.profile.srtp = 'off';
});

test('SRTP-mandatory phone rejects plain RTP with 488', async () => {
  const call = await alice.ua.call(carol.uri('tls'));
  await waitFor(() => alice.ua.calls.get(call.id).state === 'ended', 5000, 'call ended');
  assert.equal(alice.ua.calls.get(call.id).endReason, '488 Not Acceptable Here');
});

test('UDP call cancelled while ringing', async () => {
  alice.ua.profile.transport = 'udp';
  const n = bob.events.incoming.length;
  const call = await alice.ua.call(bob.uri('udp'));
  const inc = await waitFor(() => bob.events.incoming[n], 5000, 'incoming');
  await waitFor(() => alice.ua.calls.get(call.id).state === 'early', 3000, 'ringing');
  alice.ua.hangup(call.id);
  await waitFor(() => bob.ua.calls.get(inc.id).state === 'ended', 3000, 'bob ended');
  assert.equal(bob.ua.calls.get(inc.id).endReason, 'Caller cancelled');
  assert.equal(inc.transport, 'udp');
});

test('blind transfer with REFER', async () => {
  alice.ua.profile.transport = 'tls';
  carol.ua.profile.srtp = 'off';
  const call = await alice.ua.call(bob.uri('tls'));
  const inc = await waitFor(() => bob.events.incoming[bob.events.incoming.length - 1].callId === alice.ua.calls.get(call.id).callId && bob.events.incoming[bob.events.incoming.length - 1], 5000, 'incoming');
  await bob.ua.answer(inc.id);
  await waitFor(() => alice.ua.calls.get(call.id).state === 'active', 3000, 'active');

  const n = carol.events.incoming.length;
  await bob.ua.transfer(inc.id, carol.uri('tls'));
  const carolInc = await waitFor(() => carol.events.incoming[n], 5000, 'carol rings');
  await carol.ua.answer(carolInc.id);
  await waitFor(() => bob.ua.calls.get(inc.id).state === 'ended', 5000, 'bob released after transfer');
  assert.equal(bob.ua.calls.get(inc.id).endReason, 'Transferred');
  // Bob's BYE to alice is in flight when bob's side ends; wait for alice to process it.
  const activeAlice = () => [...alice.ua.calls.values()].filter((c) => c.state === 'active');
  await waitFor(() => activeAlice().length === 1, 3000, 'alice left with only the call to carol');
  const aliceCalls = activeAlice();
  assert.match(aliceCalls[0].remoteTarget, /carol/);
  alice.ua.hangup(aliceCalls[0].id);
  await waitFor(() => carol.ua.calls.get(carolInc.id).state === 'ended', 3000, 'carol ended');
});
