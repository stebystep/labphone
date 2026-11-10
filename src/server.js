'use strict';
// LabPhone application: owns the SIP transport + user agent and serves the browser UI.
// The browser talks to this process over a localhost WebSocket: JSON for control,
// binary frames for audio (16-bit PCM, 8 kHz mono, 160 samples = 20 ms per frame).
const http = require('http');
const fs = require('fs');
const path = require('path');
const { SipTransport } = require('./sip/transport');
const { UserAgent } = require('./sip/ua');
const { ConfigStore } = require('./config');
const { ensureSelfSigned } = require('./certs');
const { acceptUpgrade } = require('./ws');
const pkg = require('../package.json');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.ico': 'image/x-icon',
};
const TRACE_LIMIT = 1500;

class App {
  constructor(opts = {}) {
    this.opts = {
      httpHost: '127.0.0.1', httpPort: 8460, sipHost: '0.0.0.0', sipPort: 5060, tlsPort: 5061,
      rtpMin: 40000, rtpMax: 40999, configDir: undefined, ...opts,
    };
    this.clients = new Set();
    this.audioClient = null;
    this.trace = [];
    this.traceSeq = 1;
    this.messages = [];
    this.mwi = null;
    this.ua = null;
  }

  log(...a) { if (!this.opts.quiet) console.log('[labphone]', ...a); }

  async start() {
    this.config = new ConfigStore(this.opts.configDir);
    this.tlsServer = null;
    try {
      const c = ensureSelfSigned(path.join(this.config.dir, 'certs'));
      this.tlsServer = { cert: c.cert, key: c.key };
      this.certInfo = { file: c.certFile, created: c.created };
    } catch (e) {
      this.log(`TLS listener disabled (could not create certificate with openssl: ${e.message})`);
    }
    await this.startTransport();
    await this.startHttp();
    this.statsTimer = setInterval(() => this.pushStats(), 1000);
    await this.activateProfile(this.config.activeProfile.id);
    return this;
  }

  async startTransport() {
    let { sipPort, tlsPort } = this.opts;
    for (let attempt = 0; attempt < 10; attempt++) {
      const t = new SipTransport({ bindHost: this.opts.sipHost, sipPort, tlsPort, tlsServer: this.tlsServer });
      try {
        await t.start();
        this.transport = t;
        break;
      } catch (e) {
        await t.stop().catch(() => {});
        if (e.code !== 'EADDRINUSE' || this.opts.strictPorts) throw e;
        this.log(`SIP port ${sipPort}/${tlsPort} busy, trying ${sipPort + 10}/${tlsPort + 10}`);
        sipPort += 10;
        tlsPort += 10;
      }
    }
    if (!this.transport) throw new Error('no free SIP port');
    this.transport.on('trace', (e) => this.addTrace(e));
    this.transport.on('note', (t) => this.addNote(t));
    this.transport.on('error', (e) => this.addNote(`Transport error: ${e.message}`));
    this.log(`SIP listening on UDP/TCP ${this.transport.sipPort}${this.tlsServer ? `, TLS ${this.transport.tlsPort}` : ''} (${this.opts.sipHost})`);
  }

  async startHttp() {
    this.http = http.createServer((req, res) => this.onHttp(req, res));
    this.http.on('upgrade', (req, socket, head) => this.onUpgrade(req, socket, head));
    let port = this.opts.httpPort;
    for (let attempt = 0; ; attempt++) {
      try {
        await new Promise((resolve, reject) => {
          this.http.once('error', reject);
          this.http.listen(port, this.opts.httpHost, () => { this.http.off('error', reject); resolve(); });
        });
        break;
      } catch (e) {
        if (e.code !== 'EADDRINUSE' || attempt >= 10 || this.opts.strictPorts) throw e;
        port += 1;
      }
    }
    this.httpPort = port;
    this.url = `http://${this.opts.httpHost === '0.0.0.0' ? '127.0.0.1' : this.opts.httpHost}:${port}/`;
  }

  async stop() {
    clearInterval(this.statsTimer);
    if (this.ua) await this.ua.stop();
    for (const c of this.clients) c.close();
    if (this.http) this.http.close();
    if (this.transport) await this.transport.stop();
  }

  // ---- profile / UA lifecycle ------------------------------------------------------
  tlsClientFor(p) {
    // Accept "~/..." paths as people type them.
    const expand = (f) => (f && (f === '~' || f.startsWith('~/')) ? path.join(require('os').homedir(), f.slice(1)) : f);
    const read = (f) => { try { return f ? fs.readFileSync(expand(f)) : undefined; } catch (e) { this.addNote(`Cannot read ${f}: ${e.message}`); return undefined; } };
    return { rejectUnauthorized: !!p.tlsVerify, ca: read(p.tlsCaFile), cert: read(p.tlsCertFile), key: read(p.tlsKeyFile) };
  }

  async activateProfile(id) {
    if (this.ua) {
      const old = this.ua;
      this.ua = null;
      await old.stop();
      old.removeAllListeners();
    }
    this.config.setActive(id);
    const profile = this.config.activeProfile;
    const ua = new UserAgent({
      transport: this.transport,
      profile,
      tlsClient: this.tlsClientFor(profile),
      media: { bindHost: this.opts.sipHost, portMin: this.opts.rtpMin, portMax: this.opts.rtpMax },
    });
    this.ua = ua;
    ua.on('note', (t) => this.addNote(t));
    ua.on('registration', (r) => this.broadcast({ type: 'registration', registration: r }));
    ua.on('call', (c) => this.broadcast({ type: 'call', call: c }));
    ua.on('incoming', (c) => this.broadcast({ type: 'incoming', call: c }));
    ua.on('dtmf', (callId, digit) => this.broadcast({ type: 'dtmf', callId, digit }));
    ua.on('mwi', (m) => { this.mwi = m; this.broadcast({ type: 'mwi', mwi: m }); });
    ua.on('message', (m) => { this.messages.push(m); this.broadcast({ type: 'im', message: m }); });
    ua.on('call-ended', (c) => {
      const entry = {
        id: c.id, direction: c.direction, remote: c.remote, start: c.createdAt, connectedAt: c.connectedAt,
        end: c.endedAt, reason: c.endReason, transport: c.transport, srtp: c.srtp, profile: profile.name,
      };
      this.config.addHistory(entry);
      this.broadcast({ type: 'history', history: this.config.history });
    });
    ua.on('audio', (callId, pcm) => {
      const active = ua.audioCall();
      if (!this.audioClient || !active || active.id !== callId) return;
      this.audioClient.send(Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
    });
    this.broadcastState();
    if (profile.register && profile.domain && profile.username) ua.register().catch((e) => this.addNote(`Register failed: ${e.message}`));
  }

  // ---- trace -------------------------------------------------------------------------
  addTrace(e) {
    const entry = { id: this.traceSeq++, ...e };
    this.trace.push(entry);
    if (this.trace.length > TRACE_LIMIT) this.trace.splice(0, this.trace.length - TRACE_LIMIT);
    this.broadcast({ type: 'trace', entry });
  }

  addNote(text) {
    this.addTrace({ dir: 'note', time: Date.now(), text });
  }

  // ---- HTTP / WebSocket ------------------------------------------------------------
  allowedHost(host) {
    const h = String(host || '').toLowerCase();
    return h === `127.0.0.1:${this.httpPort}` || h === `localhost:${this.httpPort}` || h === `[::1]:${this.httpPort}`
      || (this.opts.httpHost !== '127.0.0.1' && h.endsWith(`:${this.httpPort}`));
  }

  onHttp(req, res) {
    // Reject other Host names: protects the localhost API against DNS-rebinding.
    if (!this.allowedHost(req.headers.host)) { res.writeHead(403); res.end('Forbidden host'); return; }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ app: 'labphone', version: pkg.version }));
      return;
    }
    const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end(); return; }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws://127.0.0.1:* ws://localhost:*; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
      });
      res.end(data);
    });
  }

  onUpgrade(req, socket, head) {
    const origin = req.headers.origin;
    // Only our own page may drive the phone (blocks cross-site WebSocket hijacking).
    if (!this.allowedHost(req.headers.host) || (origin && !this.allowedHost(origin.replace(/^https?:\/\//, '')))) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    if (new URL(req.url, 'http://localhost').pathname !== '/ws') { socket.end('HTTP/1.1 404 Not Found\r\n\r\n'); return; }
    const ws = acceptUpgrade(req, socket, head);
    if (!ws) return;
    this.clients.add(ws);
    ws.on('close', () => {
      this.clients.delete(ws);
      if (this.audioClient === ws) this.audioClient = null;
    });
    ws.on('text', (t) => {
      let msg;
      try { msg = JSON.parse(t); } catch { return; }
      this.onCommand(ws, msg).catch((e) => ws.sendJson({ type: 'error', ref: msg.type, message: e.message }));
    });
    ws.on('binary', (buf) => {
      if (ws !== this.audioClient || !this.ua || buf.length !== 320) return;
      const pcm = new Int16Array(160);
      for (let i = 0; i < 160; i++) pcm[i] = buf.readInt16LE(i * 2);
      this.ua.pushAudio(pcm);
    });
    ws.sendJson(this.state(true));
  }

  broadcast(obj) {
    const s = JSON.stringify(obj);
    for (const c of this.clients) c.send(s);
  }

  broadcastState() { this.broadcast(this.state(false)); }

  state(withTrace) {
    const ua = this.ua;
    return {
      type: 'state',
      app: {
        version: pkg.version, sipPort: this.transport.sipPort, tlsPort: this.tlsServer ? this.transport.tlsPort : null,
        configDir: this.config.dir, httpPort: this.httpPort, certFile: this.certInfo ? this.certInfo.file : null,
      },
      profiles: this.config.publicProfiles(),
      activeId: this.config.activeProfile.id,
      registration: ua ? ua.registration() : null,
      calls: ua ? [...ua.calls.values()].filter((c) => c.state !== 'ended').map((c) => c.snapshot()) : [],
      history: this.config.history,
      messages: this.messages.slice(-200),
      mwi: this.mwi,
      trace: withTrace ? this.trace.slice(-500) : undefined,
    };
  }

  pushStats() {
    if (!this.ua || !this.clients.size) return;
    const stats = this.ua.mediaStats();
    if (Object.keys(stats).length) this.broadcast({ type: 'stats', stats });
  }

  async onCommand(ws, m) {
    const ua = this.ua;
    switch (m.type) {
      case 'getState': ws.sendJson(this.state(true)); break;
      case 'audio': this.audioClient = m.enabled ? ws : this.audioClient === ws ? null : this.audioClient; break;
      case 'saveProfile': {
        const p = this.config.upsert(m.profile);
        if (m.activate || p.id === this.config.activeProfile.id) await this.activateProfile(p.id);
        else this.broadcastState();
        ws.sendJson({ type: 'saved', id: p.id });
        break;
      }
      case 'deleteProfile': {
        const wasActive = m.id === this.config.activeProfile.id;
        this.config.remove(m.id);
        if (wasActive) await this.activateProfile(this.config.activeProfile.id); else this.broadcastState();
        break;
      }
      case 'activateProfile': await this.activateProfile(m.id); break;
      case 'register': await ua.register(); break;
      case 'unregister': await ua.unregister(); break;
      case 'call': {
        const c = await ua.call(m.target);
        ws.sendJson({ type: 'dialing', callId: c.id });
        break;
      }
      case 'answer': await ua.answer(m.callId); break;
      case 'reject': ua.reject(m.callId, m.status || 486); break;
      case 'hangup': ua.hangup(m.callId); break;
      case 'hold': await ua.hold(m.callId, !!m.on); break;
      case 'mute': ua.mute(m.callId, !!m.on); break;
      case 'tone': ua.setTone(m.callId, !!m.on); break;
      case 'dtmf': await ua.sendDtmf(m.callId, String(m.digit).slice(0, 1)); break;
      case 'transfer': await ua.transfer(m.callId, m.target); break;
      case 'message': {
        const r = await ua.sendMessage(m.target, String(m.text || '').slice(0, 4000));
        const entry = { dir: 'out', to: m.target, text: m.text, at: Date.now(), status: `${r.status} ${r.reason}` };
        this.messages.push(entry);
        this.broadcast({ type: 'im', message: entry });
        break;
      }
      case 'clearTrace': this.trace = []; this.broadcast({ type: 'traceCleared' }); break;
      case 'clearHistory': this.config.clearHistory(); this.broadcast({ type: 'history', history: [] }); break;
      default: throw new Error(`unknown command ${m.type}`);
    }
  }
}

module.exports = { App };
