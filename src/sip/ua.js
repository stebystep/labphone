'use strict';
// The SIP User Agent: registration (RFC 3261 10), calls / dialogs (12-15), hold via re-INVITE
// (RFC 3264 8.4), blind transfer (RFC 3515), DTMF (RFC 4733 or SIP INFO), MESSAGE (RFC 3428),
// and SDES-SRTP negotiation (RFC 4568).
const crypto = require('crypto');
const { EventEmitter } = require('events');
const {
  SipMessage, parseUri, parseNameAddr, formatNameAddr, formatVia,
} = require('./message');
const { TransactionLayer, newBranch, T1, T2, TIMEOUT } = require('./transactions');
const digest = require('./digest');
const sdp = require('./sdp');
const { RtpSession } = require('../media/rtp-session');
const { SrtpContext, generateKey } = require('../media/srtp');

const USER_AGENT = 'LabPhone/1.0 (training softphone)';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, REFER, NOTIFY, MESSAGE, UPDATE';
const DTMF_PT = 101;

const rand = (n = 8) => crypto.randomBytes(n).toString('hex');
const hostForUri = (ip) => (ip.includes(':') ? `[${ip}]` : ip);

const DEFAULT_PROFILE = {
  name: 'New account', displayName: '', username: '', authUsername: '', password: '', domain: '',
  proxy: '', transport: 'udp', register: true, expires: 300, srtp: 'off', codecs: ['PCMU', 'PCMA'],
  dtmfMode: 'rfc2833', tlsVerify: false, useSips: false, autoAnswer: false, keepaliveSec: 30,
};

class Call extends EventEmitter {
  constructor(direction) {
    super();
    this.id = rand(4);
    this.direction = direction;
    this.state = direction === 'outgoing' ? 'calling' : 'ringing';
    this.callId = null;
    this.localTag = null;
    this.remoteTag = null;
    this.local = null; // { ip, port, connId }
    this.localNameAddr = null;
    this.remoteNameAddr = null;
    this.remoteTarget = null;
    this.routeSet = [];
    this.localSeq = 0;
    this.dest = null;
    this.transport = null;
    this.media = null;
    this.codec = null;
    this.dtmfPt = null;
    this.localCrypto = [];
    this.srtpSuite = null;
    this.sdpSessionId = Math.floor(Math.random() * 1e9);
    this.sdpVersion = 0;
    this.localHold = false;
    this.remoteHold = false;
    this.muted = false;
    this.tone = false;
    this.createdAt = Date.now();
    this.connectedAt = null;
    this.endedAt = null;
    this.endReason = null;
    this.statusText = '';
    this.transferStatus = null;
  }

  get remoteParty() {
    const na = this.remoteNameAddr;
    if (!na) return { display: null, uri: '' };
    return { display: na.display, uri: na.uri };
  }

  snapshot() {
    return {
      id: this.id,
      direction: this.direction,
      state: this.state,
      statusText: this.statusText,
      remote: this.remoteParty,
      callId: this.callId,
      transport: this.transport,
      codec: this.codec ? this.codec.name : null,
      srtp: this.srtpSuite,
      keysExposed: !!this.srtpSuite && this.transport !== 'tls',
      localHold: this.localHold,
      remoteHold: this.remoteHold,
      muted: this.muted,
      tone: this.tone,
      createdAt: this.createdAt,
      connectedAt: this.connectedAt,
      endedAt: this.endedAt,
      endReason: this.endReason,
      transferStatus: this.transferStatus,
    };
  }
}

class UserAgent extends EventEmitter {
  constructor({ transport, profile, tlsClient = null, media = {} }) {
    super();
    this.transport = transport;
    this.profile = { ...DEFAULT_PROFILE, ...profile };
    this.tlsClient = tlsClient;
    this.mediaOptions = media;
    this.tx = new TransactionLayer(transport);
    this.calls = new Map();
    this.reg = { state: 'unregistered', reason: '', expires: 0, at: null, connection: null };
    this.regCallId = `${rand(10)}@labphone`;
    this.regCseq = 0;
    this.regTimer = null;
    this.keepaliveTimer = null;
    this.regConnId = null;
    this.stopped = false;
    this._onMessage = (m, src) => { try { this.onMessage(m, src); } catch (e) { this.note(`Internal error handling ${m.summary()}: ${e.message}`); } };
    this._onClosed = (c) => this.onConnectionClosed(c);
    transport.on('message', this._onMessage);
    transport.on('connection-closed', this._onClosed);
  }

  note(text) { this.emit('note', text); }

  // ---- addressing helpers ----------------------------------------------------------
  get scheme() { return this.profile.useSips ? 'sips' : 'sip'; }

  get aor() {
    const p = this.profile;
    return `${this.scheme}:${p.username}@${p.domain}`;
  }

  targetUri(target) {
    const t = String(target || '').trim().replace(/\s+/g, '');
    if (!t) throw new Error('empty target');
    if (/^sips?:/i.test(t)) return t;
    if (t.includes('@')) return `${this.scheme}:${t}`;
    if (!this.profile.domain) throw new Error('No domain configured: dial user@host or a full sip: URI');
    return `${this.scheme}:${t}@${this.profile.domain}`;
  }

  withTls(dest) { return { ...dest, tlsClient: this.tlsClient }; }

  async outboundDest() {
    const p = this.profile;
    const target = p.proxy ? p.proxy.replace(/^sips?:/i, '').split(';')[0] : p.domain;
    if (!target) throw new Error('No domain or proxy configured');
    const u = parseUri(`sip:${target}`);
    return this.withTls(await this.transport.resolve({ host: u.host, port: u.port, transport: p.transport }));
  }

  async uriDest(uriStr, fallbackTransport) {
    const u = parseUri(uriStr);
    if (!u) throw new Error(`bad URI ${uriStr}`);
    const t = (u.params.transport || '').toLowerCase() || (u.scheme === 'sips' ? 'tls' : fallbackTransport || 'udp');
    const transport = ['udp', 'tcp', 'tls'].includes(t) ? t : 'udp';
    return this.withTls(await this.transport.resolve({ host: u.host, port: u.port, transport }));
  }

  async dialogDest(call) {
    const target = call.routeSet.length ? parseNameAddr(call.routeSet[0]).uri : call.remoteTarget;
    return this.uriDest(target, call.transport);
  }

  // Local address to put in Via / Contact / SDP for a destination.
  async prepare(dest) {
    if (dest.transport === 'udp') {
      return { ip: await this.transport.localIpFor(dest.address), port: this.transport.sipPort, connId: null };
    }
    const connId = await this.transport.connectionFor(dest);
    const info = this.transport.connectionInfo(connId);
    const listening = dest.transport === 'tls' ? !!this.transport.tlsServer : true;
    return { ip: info.local.address, port: listening ? this.transport.listeningPort(dest.transport) : info.local.port, connId };
  }

  contactUri(local, transport) {
    const user = this.profile.username || 'labphone';
    const tparam = transport === 'udp' ? '' : `;transport=${transport}`;
    const scheme = transport === 'tls' && this.profile.useSips ? 'sips' : 'sip';
    return `${scheme}:${user}@${hostForUri(local.ip)}:${local.port}${scheme === 'sips' ? '' : tparam}`;
  }

  stamp(req, dest, local) {
    // Via goes first, as every SIP stack (and Wireshark) shows it; each attempt gets a new branch.
    req.remove('Via');
    if (!req.has('Max-Forwards')) req.prepend('Max-Forwards', '70');
    req.prepend('Via', formatVia({ transport: dest.transport.toUpperCase(), host: hostForUri(local.ip), port: local.port, params: { branch: newBranch(), rport: null } }));
    if (!req.has('User-Agent')) req.add('User-Agent', USER_AGENT);
  }

  // Sends a request in a new client transaction, answering 401/407 digest challenges.
  async request(req, dest, { local, onProvisional, onSend } = {}) {
    let current = req;
    let attempts = 0;
    let loc = local;
    try {
      if (!loc) loc = await this.prepare(dest);
    } catch (e) {
      const r = SipMessage.response(503, `Service Unavailable (${e.message})`);
      r.local = true;
      this.note(`Cannot reach ${dest.address}:${dest.port} over ${dest.transport.toUpperCase()}: ${e.message}`);
      return { res: r, req: current, local: loc };
    }
    for (;;) {
      this.stamp(current, dest, loc);
      if (onSend) onSend(current, loc);
      const res = await this.tx.sendRequest(current, { ...dest, connId: loc.connId || undefined }, { onProvisional });
      if (res.local) this.note(`${current.method}: ${res.status} ${res.reason} (generated locally - no response from ${dest.address}:${dest.port})`);
      if ((res.status === 401 || res.status === 407) && attempts < 2) {
        const challenge = digest.pickChallenge(res.getAll(res.status === 401 ? 'WWW-Authenticate' : 'Proxy-Authenticate'));
        const stale = challenge && /^true$/i.test(challenge.stale || '');
        if (challenge && this.profile.password && (attempts === 0 || stale)) {
          attempts++;
          const next = current.clone();
          next.set('CSeq', `${current.cseq.seq + 1} ${current.method}`);
          const header = res.status === 401 ? 'Authorization' : 'Proxy-Authorization';
          next.set(header, digest.buildAuthorization({
            challenge,
            method: current.method,
            uri: current.uri,
            username: this.profile.authUsername || this.profile.username,
            password: this.profile.password,
            body: current.body,
          }));
          this.note(`${current.method}: answering ${res.status} challenge for realm "${challenge.realm}" (${challenge.algorithm || 'MD5'})`);
          current = next;
          continue;
        }
        if (attempts > 0) this.note(`${current.method}: credentials rejected (check username / auth name / password)`);
      }
      return { res, req: current, local: loc };
    }
  }

  // ---- registration ----------------------------------------------------------------
  setReg(patch) {
    this.reg = { ...this.reg, ...patch };
    this.emit('registration', this.registration());
  }

  registration() {
    return { ...this.reg, aor: this.profile.domain ? this.aor : null, transport: this.profile.transport };
  }

  async register(expires = this.profile.expires) {
    clearTimeout(this.regTimer);
    const p = this.profile;
    if (!p.domain || !p.username) { this.setReg({ state: 'unregistered', reason: 'No domain/username configured' }); return; }
    this.setReg({ state: expires ? 'registering' : 'unregistering', reason: '' });
    let dest;
    try { dest = await this.outboundDest(); } catch (e) {
      this.setReg({ state: 'failed', reason: e.message });
      this.scheduleRegRetry();
      return;
    }
    const req = SipMessage.request('REGISTER', `${this.scheme}:${p.domain}`);
    const aorNA = { display: p.displayName || null, uri: this.aor };
    req.add('From', formatNameAddr({ ...aorNA, params: { tag: rand(6) } }));
    req.add('To', formatNameAddr(aorNA));
    req.add('Call-ID', this.regCallId);
    req.add('CSeq', `${++this.regCseq} REGISTER`);
    let contactUri = null;
    const { res, req: sent, local } = await this.request(req, dest, {
      onSend: (r, loc) => {
        contactUri = this.contactUri(loc, dest.transport);
        if (!r.has('Contact')) {
          r.set('Contact', `<${contactUri}>;expires=${expires}`);
          r.set('Expires', String(expires));
          r.set('Allow', ALLOW);
        }
      },
    });
    this.regCseq = sent.cseq.seq;
    if (this.stopped && expires) return;
    if (res.status >= 200 && res.status < 300) {
      if (!expires) { this.stopKeepalive(); this.setReg({ state: 'unregistered', reason: 'Unregistered', expires: 0 }); return; }
      let granted = expires;
      for (const c of res.getAll('Contact')) {
        const na = parseNameAddr(c);
        if (na.uri === contactUri && na.params.expires) granted = parseInt(na.params.expires, 10);
      }
      if (granted === expires && res.get('Expires')) granted = parseInt(res.get('Expires'), 10);
      this.regConnId = local && local.connId;
      const connection = local && local.connId ? this.transport.connectionInfo(local.connId) : { transport: 'udp', remote: { address: dest.address, port: dest.port } };
      this.setReg({ state: 'registered', reason: `${res.status} ${res.reason}`, expires: granted, at: Date.now(), server: res.get('Server') || null, contact: contactUri, connection });
      this.regTimer = setTimeout(() => this.register(), Math.max(10, granted * 0.85) * 1000);
      this.startKeepalive();
      return;
    }
    if (res.status === 423 && res.get('Min-Expires')) {
      const min = parseInt(res.get('Min-Expires'), 10);
      this.note(`Registrar requires Expires >= ${min}; retrying`);
      this.profile.expires = min;
      this.register(min);
      return;
    }
    this.setReg({ state: expires ? 'failed' : 'unregistered', reason: `${res.status} ${res.reason}` });
    if (expires) this.scheduleRegRetry();
  }

  scheduleRegRetry() {
    clearTimeout(this.regTimer);
    if (!this.stopped && this.profile.register) this.regTimer = setTimeout(() => this.register(), 30000);
  }

  startKeepalive() {
    this.stopKeepalive();
    if (!this.regConnId || !this.profile.keepaliveSec) return;
    this.keepaliveTimer = setInterval(() => this.transport.keepalive(this.regConnId), this.profile.keepaliveSec * 1000);
  }

  stopKeepalive() { clearInterval(this.keepaliveTimer); this.keepaliveTimer = null; }

  onConnectionClosed({ id }) {
    if (id === this.regConnId && !this.stopped && this.reg.state === 'registered') {
      this.regConnId = null;
      this.stopKeepalive();
      this.setReg({ state: 'registering', reason: 'connection lost, re-registering' });
      clearTimeout(this.regTimer);
      this.regTimer = setTimeout(() => this.register(), 2000);
    }
  }

  async unregister() {
    clearTimeout(this.regTimer);
    if (this.reg.state === 'registered') await this.register(0);
    else this.setReg({ state: 'unregistered', reason: '' });
  }

  async stop() {
    this.stopped = true;
    for (const call of this.calls.values()) if (call.state !== 'ended') this.hangup(call.id);
    try { await Promise.race([this.unregister(), new Promise((r) => setTimeout(r, 2000))]); } catch { /* ignore */ }
    clearTimeout(this.regTimer);
    this.stopKeepalive();
    this.transport.off('message', this._onMessage);
    this.transport.off('connection-closed', this._onClosed);
  }

  // ---- SDP / media -----------------------------------------------------------------
  enabledCodecs() {
    const list = (this.profile.codecs || []).filter((n) => sdp.SUPPORTED_CODECS[n] !== undefined);
    return list.length ? list : ['PCMU', 'PCMA'];
  }

  offerSdp(call, direction = 'sendrecv') {
    let codecs;
    if (call.codec) codecs = [call.codec];
    else codecs = this.enabledCodecs().map((name) => ({ pt: sdp.SUPPORTED_CODECS[name], name }));
    const wantSrtp = call.srtpSuite || (!call.codec && this.profile.srtp === 'sdes');
    if (wantSrtp && !call.localCrypto.length) {
      call.localCrypto = [
        { tag: 1, suite: 'AES_CM_128_HMAC_SHA1_80', key: generateKey() },
        { tag: 2, suite: 'AES_CM_128_HMAC_SHA1_32', key: generateKey() },
      ];
    }
    call.offeredDirection = direction;
    call.sdpVersion++;
    return sdp.buildSdp({
      sessionId: call.sdpSessionId, sessionVersion: call.sdpVersion, ip: call.local.ip, port: call.media.port,
      codecs, dtmfPt: call.codec ? call.dtmfPt : DTMF_PT, crypto: wantSrtp ? call.localCrypto : [], direction,
    });
  }

  answerSdp(call, direction) {
    call.sdpVersion++;
    return sdp.buildSdp({
      sessionId: call.sdpSessionId, sessionVersion: call.sdpVersion, ip: call.local.ip, port: call.media.port,
      codecs: [call.codec], dtmfPt: call.dtmfPt, crypto: call.srtpSuite ? call.localCrypto : [], direction,
    });
  }

  // Applies a remote offer or answer. Returns our direction (for building an answer).
  // Throws { status: 488 } when the session cannot be accepted.
  applyRemoteSdp(call, body, { isOffer }) {
    const parsed = sdp.parseSdp(body);
    const m = sdp.audioMedia(parsed);
    const fail = (why) => { const e = new Error(why); e.status = 488; throw e; };
    if (!m) fail('no audio stream in SDP');
    const codec = sdp.chooseCodec(m, isOffer ? this.enabledCodecs() : ['PCMU', 'PCMA']);
    if (!codec) fail(`no common codec (offered ${m.fmts.join(',')})`);
    const secure = /SAVP/i.test(m.proto);
    let srtpTx = null;
    let srtpRx = null;
    if (secure) {
      const remoteCrypto = sdp.chooseCrypto(m);
      if (!remoteCrypto) fail('RTP/SAVP without a usable a=crypto line');
      let ours;
      if (isOffer) {
        ours = call.localCrypto.find((c) => c.suite === remoteCrypto.suite);
        ours = { tag: remoteCrypto.tag, suite: remoteCrypto.suite, key: ours ? ours.key : generateKey() };
      } else {
        ours = call.localCrypto.find((c) => c.tag === remoteCrypto.tag && c.suite === remoteCrypto.suite);
        if (!ours) fail('answer selected a crypto tag we did not offer');
      }
      call.localCrypto = [ours];
      srtpTx = call.media.srtpTx && call.srtpTxKey === ours.key ? call.media.srtpTx : new SrtpContext(ours.suite, ours.key);
      srtpRx = call.media.srtpRx && call.srtpRxKey === remoteCrypto.key ? call.media.srtpRx : new SrtpContext(remoteCrypto.suite, remoteCrypto.key);
      call.srtpTxKey = ours.key;
      call.srtpRxKey = remoteCrypto.key;
      call.srtpSuite = ours.suite;
      if (call.transport !== 'tls') this.note(`SRTP keys for call ${call.id} were exchanged in clear text over ${call.transport.toUpperCase()} - use TLS signalling to protect them`);
    } else {
      if (this.profile.srtp === 'sdes') fail('SRTP is mandatory in this profile but the peer offered plain RTP/AVP');
      call.localCrypto = [];
      call.srtpSuite = null;
    }
    const remoteDir = m.connection === '0.0.0.0' ? 'inactive' : m.direction;
    let ourDir;
    if (isOffer) {
      ourDir = sdp.answerDirection(remoteDir);
      if (call.localHold) ourDir = ourDir === 'sendrecv' ? 'sendonly' : ourDir === 'recvonly' ? 'inactive' : ourDir;
      call.remoteHold = remoteDir === 'sendonly' || remoteDir === 'inactive';
    } else {
      ourDir = call.offeredDirection || 'sendrecv';
      call.remoteHold = remoteDir === 'sendonly' || remoteDir === 'inactive';
    }
    const canSend = (ourDir === 'sendrecv' || ourDir === 'sendonly') && (remoteDir === 'sendrecv' || remoteDir === 'recvonly');
    call.codec = codec;
    call.dtmfPt = sdp.findDtmfPt(m);
    call.media.configure({
      remoteAddress: m.connection, remotePort: m.port, remoteRtcpPort: m.rtcpPort, codec,
      dtmfPt: call.dtmfPt, srtpTx, srtpRx, direction: canSend ? 'sendrecv' : 'recvonly',
    });
    call.media.muted = call.muted || call.localHold;
    return ourDir;
  }

  async createMedia(call) {
    call.media = await RtpSession.create(this.mediaOptions);
    call.media.on('audio', (pcm) => this.emit('audio', call.id, pcm));
    call.media.on('dtmf', (d) => { this.note(`Call ${call.id}: received DTMF '${d}' (RFC 4733)`); this.emit('dtmf', call.id, d); });
    call.media.on('note', (t) => this.note(`Call ${call.id}: ${t}`));
  }

  // ---- outgoing calls --------------------------------------------------------------
  async call(target) {
    const uri = this.targetUri(target);
    const call = new Call('outgoing');
    call.callId = `${rand(12)}@labphone`;
    call.localTag = rand(6);
    call.remoteNameAddr = { display: null, uri, params: {} };
    call.remoteTarget = uri;
    this.calls.set(call.id, call);
    this.update(call, 'calling', 'Resolving...');
    this.runOutgoing(call).catch((e) => this.endCall(call, `Failed: ${e.message}`));
    return call;
  }

  async runOutgoing(call) {
    const uri = call.remoteTarget;
    const viaProxy = !!this.profile.proxy || (this.profile.domain && parseUri(uri).host === this.profile.domain.toLowerCase().split(':')[0]);
    const dest = viaProxy ? await this.outboundDest() : await this.uriDest(uri, this.profile.transport);
    call.dest = dest;
    call.transport = dest.transport;
    const local = await this.prepare(dest);
    call.local = local;
    const fromUri = this.profile.domain ? this.aor : `sip:${this.profile.username || 'labphone'}@${hostForUri(local.ip)}`;
    call.localNameAddr = { display: this.profile.displayName || null, uri: fromUri, params: { tag: call.localTag } };
    await this.createMedia(call);
    if (call.state === 'ended') { call.media.stop(); return; }

    const req = SipMessage.request('INVITE', uri);
    req.add('From', formatNameAddr(call.localNameAddr));
    req.add('To', formatNameAddr({ display: null, uri, params: {} }));
    req.add('Call-ID', call.callId);
    req.add('CSeq', '1 INVITE');
    req.add('Contact', `<${this.contactUri(local, dest.transport)}>`);
    req.add('Allow', ALLOW);
    req.add('Content-Type', 'application/sdp');
    req.body = this.offerSdp(call);
    this.update(call, 'calling', 'Calling...');

    const { res, req: sent } = await this.request(req, dest, {
      local,
      onSend: (r) => { call.invite = r; },
      onProvisional: (r) => this.onInviteProvisional(call, r),
    });
    call.localSeq = sent.cseq.seq;

    if (res.status >= 200 && res.status < 300) {
      if (!call.remoteTag) this.establishDialog(call, res);
      await this.sendAck(call, sent);
      if (call.cancelRequested || call.state === 'ended') {
        this.note(`Call ${call.id}: 200 OK arrived after CANCEL - sending BYE`);
        await this.sendBye(call);
        return;
      }
      try {
        if (res.body) this.applyRemoteSdp(call, res.body, { isOffer: false });
      } catch (e) {
        this.note(`Call ${call.id}: unusable SDP answer (${e.message}) - hanging up`);
        await this.sendBye(call);
        this.endCall(call, `Media negotiation failed: ${e.message}`);
        return;
      }
      this.holdOthers(call);
      call.connectedAt = Date.now();
      call.media.start();
      this.update(call, 'active', 'Connected');
      call.emit('connected');
      return;
    }
    const reason = res.status === 487 ? 'Cancelled' : `${res.status} ${res.reason}`;
    this.endCall(call, reason, res.status);
  }

  onInviteProvisional(call, res) {
    if (res.status === 100) { this.update(call, 'calling', 'Trying'); return; }
    if (res.to.params.tag && !call.remoteTag) this.establishDialog(call, res);
    call.gotProvisional = true;
    if (call.cancelRequested) { if (!call.cancelSent) this.sendCancel(call); return; }
    if (call.state === 'ended') return;
    if (res.body && /application\/sdp/i.test(res.get('Content-Type') || '')) {
      try {
        this.applyRemoteSdp(call, res.body, { isOffer: false });
        call.media.start();
        call.earlyMedia = true;
      } catch (e) { this.note(`Call ${call.id}: ignoring early media: ${e.message}`); }
    }
    this.update(call, 'early', res.status === 180 ? 'Ringing' : `${res.status} ${res.reason}`, { earlyMedia: !!call.earlyMedia });
  }

  establishDialog(call, res) {
    call.remoteTag = res.to.params.tag || null;
    call.remoteNameAddr = { ...parseNameAddr(res.get('To')), params: { tag: call.remoteTag } };
    const contact = res.get('Contact');
    if (contact) call.remoteTarget = parseNameAddr(contact).uri;
    call.routeSet = res.getAll('Record-Route').reverse();
  }

  async sendAck(call, invite, body) {
    const ack = SipMessage.request('ACK', call.remoteTarget);
    for (const r of call.routeSet) ack.add('Route', r);
    ack.add('From', formatNameAddr(call.localNameAddr));
    ack.add('To', formatNameAddr(call.remoteNameAddr));
    ack.add('Call-ID', call.callId);
    ack.add('CSeq', `${invite.cseq.seq} ACK`);
    if (body) { ack.add('Content-Type', 'application/sdp'); ack.body = body; }
    const dest = await this.dialogDest(call);
    const local = await this.prepare(dest);
    this.stamp(ack, dest, local);
    call.lastAck = { ack, dest: { ...dest, connId: local.connId || undefined }, cseq: invite.cseq.seq };
    await this.transport.send(ack, call.lastAck.dest).catch((e) => this.note(`ACK failed: ${e.message}`));
  }

  sendCancel(call) {
    const inv = call.invite;
    if (!inv) return;
    call.cancelSent = true;
    const c = SipMessage.request('CANCEL', inv.uri);
    c.add('Via', inv.get('Via'));
    for (const r of inv.getAll('Route')) c.add('Route', r);
    c.add('Max-Forwards', '70');
    c.add('From', inv.get('From'));
    c.add('To', inv.get('To'));
    c.add('Call-ID', inv.callId);
    c.add('CSeq', `${inv.cseq.seq} CANCEL`);
    c.add('User-Agent', USER_AGENT);
    this.tx.sendRequest(c, { ...call.dest, connId: call.local.connId || undefined });
    if (call.state !== 'ended') this.update(call, call.state, 'Cancelling...');
  }

  // ---- in-dialog requests ----------------------------------------------------------
  async inDialog(call, method, { body, contentType, headers = {} } = {}) {
    const req = SipMessage.request(method, call.remoteTarget);
    for (const r of call.routeSet) req.add('Route', r);
    req.add('From', formatNameAddr(call.localNameAddr));
    req.add('To', formatNameAddr(call.remoteNameAddr));
    req.add('Call-ID', call.callId);
    req.add('CSeq', `${++call.localSeq} ${method}`);
    if (['INVITE', 'UPDATE', 'REFER', 'NOTIFY'].includes(method)) req.add('Contact', `<${this.contactUri(call.local, call.transport)}>`);
    for (const [k, v] of Object.entries(headers)) req.add(k, v);
    if (body !== undefined) { req.add('Content-Type', contentType || 'application/sdp'); req.body = body; }
    const dest = await this.dialogDest(call);
    const out = await this.request(req, dest);
    call.localSeq = Math.max(call.localSeq, out.req.cseq.seq);
    return out;
  }

  async sendBye(call) {
    call.byeSent = true;
    const { res } = await this.inDialog(call, 'BYE');
    return res;
  }

  // ---- user actions ----------------------------------------------------------------
  getCall(id) {
    const c = this.calls.get(id);
    if (!c) throw new Error(`no such call ${id}`);
    return c;
  }

  hangup(id) {
    const call = this.getCall(id);
    if (call.state === 'ended') return;
    if (call.direction === 'incoming' && call.state === 'ringing') { this.reject(id, 603); return; }
    if (call.direction === 'outgoing' && (call.state === 'calling' || call.state === 'early')) {
      call.cancelRequested = true;
      // A CANCEL may only be sent once a provisional response arrived (9.1); until then we
      // just remember it, and onInviteProvisional sends it.
      if (call.gotProvisional) this.sendCancel(call);
      else this.note(`Call ${call.id}: CANCEL deferred until a provisional response arrives`);
      this.endCall(call, 'Cancelled');
      return;
    }
    this.sendBye(call).catch(() => {});
    this.endCall(call, 'Local hangup');
  }

  async answer(id) {
    const call = this.getCall(id);
    if (call.direction !== 'incoming' || call.state !== 'ringing') return;
    clearTimeout(call.autoAnswerTimer);
    const res = this.buildResponse(call.inviteReq, 200, null, { toTag: call.localTag, contact: true });
    res.add('Allow', ALLOW);
    res.add('Content-Type', 'application/sdp');
    res.body = call.lateOffer ? this.offerSdp(call) : this.answerSdp(call, call.answerDirection);
    this.holdOthers(call);
    call.inviteTx.respond(res);
    this.awaitAck(call, res, call.inviteTx.src);
    call.connectedAt = Date.now();
    if (!call.lateOffer) call.media.start();
    this.update(call, 'active', 'Connected');
    call.emit('connected');
  }

  reject(id, status = 486) {
    const call = this.getCall(id);
    if (call.direction !== 'incoming' || call.state !== 'ringing') return;
    clearTimeout(call.autoAnswerTimer);
    call.inviteTx.respond(this.buildResponse(call.inviteReq, status, null, { toTag: call.localTag }));
    this.endCall(call, status === 486 ? 'Rejected (busy)' : 'Declined');
  }

  async hold(id, on) {
    const call = this.getCall(id);
    if (call.state !== 'active' || call.reinviteInProgress) return;
    if (!!call.localHold === !!on) return;
    call.reinviteInProgress = true;
    call.localHold = !!on;
    call.media.muted = call.muted || call.localHold;
    this.update(call, 'active', on ? 'Putting on hold...' : 'Resuming...');
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const body = this.offerSdp(call, on ? 'sendonly' : 'sendrecv');
        const { res, req } = await this.inDialog(call, 'INVITE', { body, contentType: 'application/sdp' });
        if (res.status >= 200 && res.status < 300) {
          await this.sendAck(call, req);
          const contact = res.get('Contact');
          if (contact) call.remoteTarget = parseNameAddr(contact).uri;
          if (res.body) this.applyRemoteSdp(call, res.body, { isOffer: false });
          this.update(call, 'active', on ? 'On hold' : 'Connected');
          return;
        }
        if (res.status === 491) { await new Promise((r) => setTimeout(r, 2100 + Math.random() * 1900)); continue; }
        if (res.status === 408 || res.status === 481) { this.endCall(call, `re-INVITE failed: ${res.status} ${res.reason}`); return; }
        call.localHold = !on;
        call.media.muted = call.muted || call.localHold;
        this.update(call, 'active', `Hold failed: ${res.status} ${res.reason}`);
        return;
      }
    } catch (e) {
      call.localHold = !on;
      this.update(call, 'active', `Hold failed: ${e.message}`);
    } finally {
      call.reinviteInProgress = false;
    }
  }

  holdOthers(except) {
    for (const c of this.calls.values()) {
      if (c !== except && c.state === 'active' && !c.localHold) this.hold(c.id, true);
    }
  }

  mute(id, on) {
    const call = this.getCall(id);
    call.muted = !!on;
    if (call.media) call.media.muted = call.muted || call.localHold;
    this.update(call, call.state, call.statusText);
  }

  setTone(id, on) {
    const call = this.getCall(id);
    call.tone = !!on;
    if (call.media) call.media.tone = call.tone;
    this.update(call, call.state, call.statusText);
  }

  async sendDtmf(id, digit) {
    const call = this.getCall(id);
    if (call.state !== 'active' && !call.earlyMedia) return;
    const useInfo = this.profile.dtmfMode === 'info' || call.dtmfPt === null;
    if (!useInfo) { call.media.sendDtmf(digit); return; }
    const { res } = await this.inDialog(call, 'INFO', {
      body: `Signal=${digit}\r\nDuration=160\r\n`, contentType: 'application/dtmf-relay',
    });
    if (res.status >= 300) this.note(`DTMF via SIP INFO rejected: ${res.status} ${res.reason}`);
  }

  async transfer(id, target) {
    const call = this.getCall(id);
    if (call.state !== 'active') throw new Error('call is not active');
    const uri = this.targetUri(target);
    call.transferStatus = `Transferring to ${uri}...`;
    this.update(call, call.state, call.statusText);
    const { res } = await this.inDialog(call, 'REFER', {
      headers: { 'Refer-To': `<${uri}>`, 'Referred-By': `<${call.localNameAddr.uri}>` },
    });
    call.transferStatus = res.status < 300 ? `Transfer accepted (${res.status}), waiting for NOTIFY...` : `Transfer refused: ${res.status} ${res.reason}`;
    this.update(call, call.state, call.statusText);
  }

  async sendMessage(target, text) {
    const uri = this.targetUri(target);
    const viaProxy = !!this.profile.proxy || (this.profile.domain && parseUri(uri).host === this.profile.domain.toLowerCase());
    const dest = viaProxy ? await this.outboundDest() : await this.uriDest(uri, this.profile.transport);
    const req = SipMessage.request('MESSAGE', uri);
    const fromUri = this.profile.domain ? this.aor : `sip:${this.profile.username || 'labphone'}@${hostForUri(await this.transport.localIpFor(dest.address))}`;
    req.add('From', formatNameAddr({ display: this.profile.displayName || null, uri: fromUri, params: { tag: rand(6) } }));
    req.add('To', `<${uri}>`);
    req.add('Call-ID', `${rand(12)}@labphone`);
    req.add('CSeq', '1 MESSAGE');
    req.add('Content-Type', 'text/plain;charset=utf-8');
    req.body = text;
    const { res } = await this.request(req, dest);
    return { status: res.status, reason: res.reason };
  }

  // ---- incoming --------------------------------------------------------------------
  buildResponse(req, status, reason, { toTag, contact, call } = {}) {
    const res = SipMessage.response(status, reason);
    for (const v of req.getAll('Via')) res.add('Via', v);
    res.add('From', req.get('From'));
    const to = parseNameAddr(req.get('To'));
    if (toTag && !to.params.tag && status !== 100) to.params.tag = toTag;
    res.add('To', status === 100 ? req.get('To') : formatNameAddr(to));
    res.add('Call-ID', req.callId);
    res.add('CSeq', req.get('CSeq'));
    if (status > 100 && status < 300 && req.method === 'INVITE') for (const rr of req.getAll('Record-Route')) res.add('Record-Route', rr);
    if (contact) {
      const c = call || this.findCallByReq(req);
      const local = c ? c.local : null;
      if (local) res.add('Contact', `<${this.contactUri(local, c.transport)}>`);
    }
    res.add('Server', USER_AGENT);
    return res;
  }

  findCallByReq(req) {
    for (const c of this.calls.values()) if (c.callId === req.callId) return c;
    return null;
  }

  findDialog(callId, localTag, remoteTag) {
    for (const c of this.calls.values()) {
      if (c.callId === callId && c.localTag === localTag && (!c.remoteTag || !remoteTag || c.remoteTag === remoteTag)) return c;
    }
    return null;
  }

  onMessage(msg, src) {
    if (msg.isResponse) {
      if (!this.tx.handleResponse(msg)) this.onStrayResponse(msg);
      return;
    }
    const { tx, retransmission } = this.tx.serverTransaction(msg, src);
    if (retransmission) return;
    if (msg.method === 'ACK') { this.onAck(msg); return; }
    const respond = (status, reason, opts) => tx.respond(this.buildResponse(msg, status, reason, opts));

    const unsupported = msg.getAll('Require').filter((x) => !['timer'].includes(x.toLowerCase()));
    if (unsupported.length && msg.method !== 'CANCEL') {
      const r = this.buildResponse(msg, 420);
      r.add('Unsupported', unsupported.join(', '));
      tx.respond(r);
      return;
    }
    if (msg.method === 'CANCEL') { this.onCancel(msg, tx); return; }

    const toTag = msg.to.params.tag;
    if (toTag) {
      const call = this.findDialog(msg.callId, toTag, msg.from.params.tag);
      if (!call) { respond(481); return; }
      this.onInDialog(call, msg, tx, src);
      return;
    }
    switch (msg.method) {
      case 'INVITE': this.onIncomingInvite(msg, tx, src).catch((e) => { this.note(`Incoming call failed: ${e.message}`); respond(500); }); break;
      case 'OPTIONS': {
        const r = this.buildResponse(msg, 200);
        r.add('Allow', ALLOW);
        r.add('Accept', 'application/sdp');
        tx.respond(r);
        break;
      }
      case 'MESSAGE': respond(200); this.emitIm(msg); break;
      case 'NOTIFY': respond(200); this.onOutOfDialogNotify(msg); break;
      case 'BYE': respond(481); break;
      default: {
        const r = this.buildResponse(msg, 405);
        r.add('Allow', ALLOW);
        tx.respond(r);
      }
    }
  }

  emitIm(msg) {
    const from = parseNameAddr(msg.get('From'));
    this.emit('message', { from: from.display ? `${from.display} <${from.uri}>` : from.uri, text: msg.body, at: Date.now(), dir: 'in' });
  }

  onOutOfDialogNotify(msg) {
    if (/message-summary/i.test(msg.get('Event') || '')) {
      const waiting = /Messages-Waiting:\s*yes/i.test(msg.body);
      const vm = /Voice-Message:\s*(\d+)\/(\d+)/i.exec(msg.body);
      this.emit('mwi', { waiting, newMessages: vm ? parseInt(vm[1], 10) : null, oldMessages: vm ? parseInt(vm[2], 10) : null });
    }
  }

  async onIncomingInvite(req, tx, src) {
    tx.respond(this.buildResponse(req, 100));
    const call = new Call('incoming');
    call.callId = req.callId;
    call.localTag = rand(6);
    call.remoteTag = req.from.params.tag || null;
    call.remoteNameAddr = parseNameAddr(req.get('From'));
    const to = parseNameAddr(req.get('To'));
    call.localNameAddr = { display: to.display, uri: to.uri, params: { tag: call.localTag } };
    const contact = req.get('Contact');
    call.remoteTarget = contact ? parseNameAddr(contact).uri : call.remoteNameAddr.uri;
    call.routeSet = req.getAll('Record-Route');
    call.localSeq = Math.floor(Math.random() * 1000) + 1;
    call.transport = src.transport;
    call.inviteReq = req;
    call.inviteTx = tx;
    const ip = src.connId ? this.transport.connectionInfo(src.connId)?.local.address : await this.transport.localIpFor(src.address);
    call.local = { ip: ip || '127.0.0.1', port: this.transport.listeningPort(src.transport), connId: src.connId || null };
    this.calls.set(call.id, call);
    await this.createMedia(call);
    if (req.body) {
      try {
        call.answerDirection = this.applyRemoteSdp(call, req.body, { isOffer: true });
      } catch (e) {
        this.note(`Incoming call rejected: ${e.message}`);
        const r = this.buildResponse(req, e.status || 500, null, { toTag: call.localTag });
        if (e.status === 488) r.add('Warning', `399 labphone "${e.message}"`);
        tx.respond(r);
        this.endCall(call, `Rejected: ${e.message}`);
        return;
      }
    } else {
      call.lateOffer = true;
    }
    tx.respond(this.buildResponse(req, 180, null, { toTag: call.localTag, contact: true, call }));
    this.update(call, 'ringing', 'Incoming call');
    this.emit('incoming', call.snapshot());
    if (this.profile.autoAnswer) call.autoAnswerTimer = setTimeout(() => this.answer(call.id).catch(() => {}), 1000);
  }

  // UAS keeps retransmitting 2xx until the ACK arrives (13.3.1.4).
  awaitAck(call, res, src) {
    call.acked = false;
    let interval = T1;
    let elapsed = 0;
    const reliable = src.transport !== 'udp';
    const tick = () => {
      if (call.acked || call.state === 'ended') return;
      elapsed += interval;
      if (elapsed >= TIMEOUT || reliable) {
        this.note(`Call ${call.id}: no ACK received for 200 OK - ending call`);
        this.sendBye(call).catch(() => {});
        this.endCall(call, 'No ACK received');
        return;
      }
      this.transport.send(res, src).catch(() => {});
      interval = Math.min(interval * 2, T2);
      call.ackTimer = setTimeout(tick, interval);
    };
    call.ackTimer = setTimeout(tick, reliable ? TIMEOUT : interval);
  }

  onAck(ack) {
    const call = this.findDialog(ack.callId, ack.to.params.tag, ack.from.params.tag);
    if (!call) return;
    call.acked = true;
    clearTimeout(call.ackTimer);
    if (call.pendingOfferInResponse && ack.body) {
      call.pendingOfferInResponse = false;
      try {
        this.applyRemoteSdp(call, ack.body, { isOffer: false });
        call.media.start();
      } catch (e) {
        this.note(`Call ${call.id}: bad SDP in ACK: ${e.message}`);
      }
      this.update(call, call.state, call.statusText);
    } else if (call.lateOffer && ack.body) {
      call.lateOffer = false;
      try {
        this.applyRemoteSdp(call, ack.body, { isOffer: false });
        call.media.start();
      } catch (e) {
        this.note(`Call ${call.id}: bad SDP answer in ACK: ${e.message}`);
        this.sendBye(call).catch(() => {});
        this.endCall(call, 'Media negotiation failed');
      }
    }
  }

  onCancel(cancel, tx) {
    const inviteTx = this.tx.findInviteServerTx(cancel);
    if (!inviteTx) { tx.respond(this.buildResponse(cancel, 481)); return; }
    tx.respond(this.buildResponse(cancel, 200));
    const call = [...this.calls.values()].find((c) => c.inviteTx === inviteTx);
    if (call && call.state === 'ringing') {
      inviteTx.respond(this.buildResponse(inviteTx.req, 487, null, { toTag: call.localTag }));
      this.endCall(call, 'Caller cancelled');
    }
  }

  onStrayResponse(res) {
    const cseq = res.cseq;
    if (!cseq || cseq.method !== 'INVITE' || res.status < 200 || res.status >= 300) return;
    for (const call of this.calls.values()) {
      if (call.callId !== res.callId || !call.lastAck || call.lastAck.cseq !== cseq.seq) continue;
      // 2xx retransmission: our ACK was lost, send it again (13.2.2.4).
      this.transport.send(call.lastAck.ack, call.lastAck.dest).catch(() => {});
      return;
    }
  }

  onInDialog(call, req, tx, src) {
    const respond = (status, reason, opts) => tx.respond(this.buildResponse(req, status, reason, { call, ...opts }));
    if (call.state === 'ended' && req.method !== 'BYE') { respond(481); return; }
    switch (req.method) {
      case 'BYE':
        respond(200);
        if (call.state !== 'ended') this.endCall(call, 'Remote hangup');
        break;
      case 'INVITE':
      case 'UPDATE': this.onReinvite(call, req, tx); break;
      case 'INFO': {
        respond(200);
        const ct = req.get('Content-Type') || '';
        let digit = null;
        if (/dtmf-relay/i.test(ct)) { const m = /Signal\s*=\s*([0-9*#A-D])/i.exec(req.body); digit = m && m[1]; }
        else if (/application\/dtmf/i.test(ct)) digit = req.body.trim()[0];
        if (digit) { this.note(`Call ${call.id}: received DTMF '${digit}' (SIP INFO)`); this.emit('dtmf', call.id, digit); }
        break;
      }
      case 'REFER': this.onRefer(call, req, tx); break;
      case 'NOTIFY': {
        respond(200);
        if (/^refer/i.test(req.get('Event') || '')) {
          const m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/m.exec(req.body);
          if (m) {
            const code = parseInt(m[1], 10);
            call.transferStatus = `Transfer progress: ${m[1]} ${m[2]}`;
            this.update(call, call.state, call.statusText);
            if (code >= 200 && code < 300 && call.state === 'active') {
              call.transferStatus = 'Transfer completed';
              this.sendBye(call).catch(() => {});
              this.endCall(call, 'Transferred');
            } else if (code >= 300) {
              call.transferStatus = `Transfer failed: ${m[1]} ${m[2]}`;
              this.update(call, call.state, call.statusText);
            }
          }
        }
        break;
      }
      case 'MESSAGE': respond(200); this.emitIm(req); break;
      case 'OPTIONS': { const r = this.buildResponse(req, 200); r.add('Allow', ALLOW); tx.respond(r); break; }
      default: { const r = this.buildResponse(req, 405); r.add('Allow', ALLOW); tx.respond(r); }
    }
  }

  onReinvite(call, req, tx) {
    if (call.reinviteInProgress && req.method === 'INVITE') {
      tx.respond(this.buildResponse(req, 491, null, { call }));
      return;
    }
    const contact = req.get('Contact');
    if (contact) call.remoteTarget = parseNameAddr(contact).uri;
    const res = this.buildResponse(req, 200, null, { contact: true, call });
    if (req.body) {
      let dir;
      try { dir = this.applyRemoteSdp(call, req.body, { isOffer: true }); } catch (e) {
        const r = this.buildResponse(req, 488, null, { call });
        r.add('Warning', `399 labphone "${e.message}"`);
        tx.respond(r);
        return;
      }
      res.add('Content-Type', 'application/sdp');
      res.body = this.answerSdp(call, dir);
    } else if (req.method === 'INVITE') {
      res.add('Content-Type', 'application/sdp');
      res.body = this.offerSdp(call, call.localHold ? 'sendonly' : 'sendrecv');
      call.pendingOfferInResponse = true;
    }
    tx.respond(res);
    if (req.method === 'INVITE') this.awaitAck(call, res, tx.src);
    this.update(call, call.state, call.remoteHold ? 'Held by remote party' : call.localHold ? 'On hold' : 'Connected');
  }

  async onRefer(call, req, tx) {
    const referTo = req.get('Refer-To');
    if (!referTo) { tx.respond(this.buildResponse(req, 400, 'Missing Refer-To', { call })); return; }
    const uri = parseNameAddr(referTo).uri.split('?')[0];
    tx.respond(this.buildResponse(req, 202, null, { call }));
    this.note(`Call ${call.id}: transfer requested to ${uri}`);
    const notify = (frag, final) => this.inDialog(call, 'NOTIFY', {
      body: `${frag}\r\n`, contentType: 'message/sipfrag;version=2.0',
      headers: { Event: 'refer', 'Subscription-State': final ? 'terminated;reason=noresource' : 'active;expires=60' },
    }).catch(() => {});
    await notify('SIP/2.0 100 Trying', false);
    let newCall;
    try { newCall = await this.call(uri); } catch (e) { await notify('SIP/2.0 503 Service Unavailable', true); return; }
    newCall.once('connected', () => notify('SIP/2.0 200 OK', true));
    newCall.once('ended', (code) => { if (!newCall.connectedAt) notify(`SIP/2.0 ${code || 487} ${newCall.endReason}`, true); });
  }

  // ---- bookkeeping -----------------------------------------------------------------
  update(call, state, statusText, extra = {}) {
    call.state = state;
    if (statusText !== undefined) call.statusText = statusText;
    Object.assign(call, extra);
    this.emit('call', call.snapshot());
  }

  endCall(call, reason, code) {
    if (call.state === 'ended') return;
    clearTimeout(call.ackTimer);
    clearTimeout(call.autoAnswerTimer);
    call.endReason = reason;
    call.endedAt = Date.now();
    if (call.media) call.media.stop();
    this.update(call, 'ended', reason);
    call.emit('ended', code);
    this.emit('call-ended', call.snapshot());
    // Keep the dialog around briefly so retransmitted BYE/ACK still find it.
    setTimeout(() => this.calls.delete(call.id), TIMEOUT).unref();
  }

  mediaStats() {
    const out = {};
    for (const c of this.calls.values()) if (c.media && c.state !== 'ended') out[c.id] = c.media.snapshot();
    return out;
  }

  // The call whose audio goes to/from the browser: the newest active call that is not on hold.
  audioCall() {
    let best = null;
    for (const c of this.calls.values()) {
      const live = c.state === 'active' || (c.state === 'early' && c.earlyMedia);
      if (live && !c.localHold && c.media && (!best || (c.connectedAt || 0) >= (best.connectedAt || 0))) best = c;
    }
    return best;
  }

  pushAudio(pcm) {
    const c = this.audioCall();
    if (c) c.media.pushAudio(pcm);
  }
}

module.exports = { UserAgent, Call, DEFAULT_PROFILE, USER_AGENT };
