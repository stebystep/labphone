'use strict';
// SIP transport layer: UDP, TCP and TLS (RFC 3261 section 18), plus RFC 3263-style
// DNS resolution (SRV, then A/AAAA) and RFC 5626 CRLF keep-alives for TCP/TLS.
const dgram = require('dgram');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const { EventEmitter } = require('events');
const { parse, StreamParser } = require('./message');

const DEFAULT_PORT = { udp: 5060, tcp: 5060, tls: 5061 };

class SipTransport extends EventEmitter {
  constructor({ bindHost = '0.0.0.0', sipPort = 5060, tlsPort = 5061, tlsServer = null } = {}) {
    super();
    this.bindHost = bindHost;
    this.sipPort = sipPort;
    this.tlsPort = tlsPort;
    this.tlsServerOptions = tlsServer; // { cert, key } or null -> no TLS listener
    this.udp = null;
    this.tcpServer = null;
    this.tlsServer = null;
    this.connections = new Map(); // connId -> { socket, transport, remote, tlsInfo }
    this.byRemote = new Map(); // "tls:1.2.3.4:5061" -> connId
    this.pending = new Map(); // same key -> Promise<connId>
    this.nextConnId = 1;
    this.dnsCache = new Map();
  }

  async start() {
    this.udp = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    this.udp.on('message', (buf, rinfo) => this._receive(buf, { transport: 'udp', address: rinfo.address, port: rinfo.port }));
    this.udp.on('error', (e) => this.emit('error', e));
    await new Promise((resolve, reject) => {
      this.udp.once('error', reject);
      this.udp.bind(this.sipPort, this.bindHost, () => { this.udp.off('error', reject); resolve(); });
    });

    this.tcpServer = net.createServer((sock) => this._adopt(sock, 'tcp'));
    await listen(this.tcpServer, this.sipPort, this.bindHost);

    if (this.tlsServerOptions) {
      this.tlsServer = tls.createServer({ ...this.tlsServerOptions, minVersion: 'TLSv1.2' }, (sock) => this._adopt(sock, 'tls'));
      this.tlsServer.on('tlsClientError', (err, sock) => this.emit('note', `TLS handshake from ${sock.remoteAddress} failed: ${err.message}`));
      await listen(this.tlsServer, this.tlsPort, this.bindHost);
    }
  }

  async stop() {
    for (const c of this.connections.values()) c.socket.destroy();
    this.connections.clear();
    this.byRemote.clear();
    if (this.udp) this.udp.close();
    if (this.tcpServer) this.tcpServer.close();
    if (this.tlsServer) this.tlsServer.close();
  }

  listeningPort(transport) {
    return transport === 'tls' ? this.tlsPort : this.sipPort;
  }

  // ---- DNS (RFC 3263, simplified) -------------------------------------------------
  async resolve({ host, port, transport }) {
    const t = transport || 'udp';
    if (net.isIP(stripBrackets(host))) return { transport: t, address: stripBrackets(host), port: port || DEFAULT_PORT[t], servername: null };
    const key = `${t}|${host}|${port || ''}`;
    const cached = this.dnsCache.get(key);
    if (cached && cached.expires > Date.now()) return cached.value;

    let target = host;
    let targetPort = port;
    if (!port) {
      const srvName = `${t === 'tls' ? '_sips._tcp' : t === 'tcp' ? '_sip._tcp' : '_sip._udp'}.${host}`;
      try {
        const records = await dns.promises.resolveSrv(srvName);
        if (records.length) {
          records.sort((a, b) => a.priority - b.priority || b.weight - a.weight);
          target = records[0].name;
          targetPort = records[0].port;
          this.emit('note', `DNS SRV ${srvName} -> ${target}:${targetPort}`);
        }
      } catch {
        this.emit('note', `DNS SRV ${srvName}: no record, using A/AAAA lookup of ${host}`);
      }
    }
    const { address } = await dns.promises.lookup(target, { family: 4 }).catch(() => dns.promises.lookup(target));
    this.emit('note', `DNS ${target} -> ${address}`);
    const value = { transport: t, address, port: targetPort || DEFAULT_PORT[t], servername: target };
    this.dnsCache.set(key, { value, expires: Date.now() + 60000 });
    return value;
  }

  // Which local IP would the OS use to reach `address`? (UDP "connect" trick, no packet is sent.)
  localIpFor(address) {
    return new Promise((resolve) => {
      const family = net.isIPv6(address) ? 'udp6' : 'udp4';
      const s = dgram.createSocket(family);
      s.on('error', () => { s.close(); resolve(family === 'udp6' ? '::1' : '127.0.0.1'); });
      s.connect(9, address, () => {
        const ip = s.address().address;
        s.close();
        resolve(ip === '0.0.0.0' ? '127.0.0.1' : ip);
      });
    });
  }

  // ---- sending --------------------------------------------------------------------
  // dest: { transport, address, port, servername?, connId?, tlsClient? }
  async send(msg, dest) {
    const raw = Buffer.from(typeof msg === 'string' ? msg : msg.toString());
    if (dest.transport === 'udp') {
      await new Promise((resolve, reject) => this.udp.send(raw, dest.port, dest.address, (e) => (e ? reject(e) : resolve())));
      const local = this.udp.address();
      this._trace('out', msg, raw, { transport: 'udp', address: dest.address, port: dest.port }, { address: dest.localIp || local.address, port: local.port });
      return { connId: null };
    }
    const connId = await this.connectionFor(dest);
    const conn = this.connections.get(connId);
    if (!conn) throw new Error('connection closed');
    conn.socket.write(raw);
    conn.lastUsed = Date.now();
    this._trace('out', msg, raw, { transport: conn.transport, address: conn.remote.address, port: conn.remote.port }, conn.local, connId);
    return { connId };
  }

  async connectionFor(dest) {
    if (dest.connId && this.connections.has(dest.connId)) return dest.connId;
    const key = `${dest.transport}:${dest.address}:${dest.port}`;
    if (this.byRemote.has(key)) return this.byRemote.get(key);
    if (this.pending.has(key)) return this.pending.get(key);
    const p = this._connect(dest).finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  _connect(dest) {
    return new Promise((resolve, reject) => {
      let sock;
      const timer = setTimeout(() => { sock.destroy(); reject(new Error(`connect timeout to ${dest.address}:${dest.port}`)); }, 8000);
      const onError = (e) => { clearTimeout(timer); reject(e); };
      if (dest.transport === 'tls') {
        const opts = dest.tlsClient || {};
        this.emit('note', `TLS: connecting to ${dest.address}:${dest.port} (SNI ${dest.servername || 'none'}, verify ${opts.rejectUnauthorized ? 'on' : 'off'})`);
        sock = tls.connect({
          host: dest.address,
          port: dest.port,
          servername: dest.servername && !net.isIP(dest.servername) ? dest.servername : undefined,
          rejectUnauthorized: !!opts.rejectUnauthorized,
          ca: opts.ca || undefined,
          cert: opts.cert || undefined,
          key: opts.key || undefined,
          minVersion: 'TLSv1.2',
        }, () => {
          clearTimeout(timer);
          sock.off('error', onError);
          const id = this._adopt(sock, 'tls', dest);
          const info = this.connections.get(id).tlsInfo;
          this.emit('note', `TLS established with ${dest.address}:${dest.port}: ${info.protocol} ${info.cipher}; certificate "${info.subject}" issued by "${info.issuer}" - ${info.authorized ? 'verified' : `NOT verified (${info.authError})`}`);
          resolve(id);
        });
      } else {
        sock = net.connect({ host: dest.address, port: dest.port }, () => {
          clearTimeout(timer);
          sock.off('error', onError);
          resolve(this._adopt(sock, 'tcp', dest));
        });
      }
      sock.once('error', onError);
    });
  }

  _adopt(sock, transport, dest = null) {
    const id = this.nextConnId++;
    const remote = { address: normalizeAddr(sock.remoteAddress), port: sock.remotePort };
    const conn = {
      id, socket: sock, transport, remote,
      local: { address: normalizeAddr(sock.localAddress), port: sock.localPort },
      outbound: !!dest, lastUsed: Date.now(), tlsInfo: null,
    };
    if (transport === 'tls') conn.tlsInfo = describeTls(sock);
    this.connections.set(id, conn);
    const keys = [`${transport}:${remote.address}:${remote.port}`];
    if (dest) keys.push(`${transport}:${dest.address}:${dest.port}`);
    for (const k of keys) this.byRemote.set(k, id);

    const parser = new StreamParser({
      onMessage: (buf) => this._receive(buf, { transport, address: remote.address, port: remote.port, connId: id }),
      onPing: () => sock.write('\r\n'),
      onError: (e) => this.emit('note', `stream error from ${remote.address}:${remote.port}: ${e.message}`),
    });
    sock.on('data', (d) => parser.push(d));
    sock.on('error', (e) => this.emit('note', `${transport.toUpperCase()} connection ${remote.address}:${remote.port} error: ${e.message}`));
    sock.on('close', () => {
      this.connections.delete(id);
      for (const k of keys) if (this.byRemote.get(k) === id) this.byRemote.delete(k);
      this.emit('note', `${transport.toUpperCase()} connection to ${remote.address}:${remote.port} closed`);
      this.emit('connection-closed', { id, transport, remote });
    });
    if (!dest) this.emit('note', `${transport.toUpperCase()} connection accepted from ${remote.address}:${remote.port}${conn.tlsInfo ? ` (${conn.tlsInfo.protocol} ${conn.tlsInfo.cipher})` : ''}`);
    return id;
  }

  connectionInfo(connId) {
    const c = this.connections.get(connId);
    if (!c) return null;
    return { transport: c.transport, remote: c.remote, local: c.local, tls: c.tlsInfo };
  }

  keepalive(connId) {
    const c = this.connections.get(connId);
    if (c) c.socket.write('\r\n\r\n');
  }

  // ---- receiving ------------------------------------------------------------------
  _receive(buf, src) {
    let msg;
    try {
      msg = parse(buf);
    } catch (e) {
      if (src.transport === 'udp' && buf.length <= 4 && /^[\r\n]*$/.test(buf.toString())) return; // UDP keep-alive
      this.emit('note', `Unparseable message from ${src.address}:${src.port}: ${e.message}`);
      return;
    }
    let local;
    if (src.connId) local = this.connections.get(src.connId)?.local;
    else local = { address: this.udp.address().address, port: this.udp.address().port };
    this._trace('in', msg, buf, src, local, src.connId);
    this.emit('message', msg, src);
  }

  _trace(dir, msg, raw, remote, local, connId) {
    this.emit('trace', {
      dir,
      time: Date.now(),
      transport: remote.transport,
      remote: `${remote.address}:${remote.port}`,
      local: local ? `${local.address}:${local.port}` : '',
      raw: raw.toString('utf8'),
      summary: typeof msg === 'string' ? msg.split('\r\n')[0] : msg.summary(),
      callId: typeof msg === 'string' ? null : msg.callId,
      connId: connId || null,
    });
  }
}

function describeTls(sock) {
  const cert = sock.getPeerCertificate ? sock.getPeerCertificate() : null;
  const cipher = sock.getCipher ? sock.getCipher() : null;
  const name = (o) => (o ? Object.entries(o).map(([k, v]) => `${k}=${v}`).join(', ') : '');
  return {
    protocol: sock.getProtocol ? sock.getProtocol() : '',
    cipher: cipher ? cipher.name : '',
    authorized: !!sock.authorized,
    authError: sock.authorizationError ? String(sock.authorizationError) : null,
    subject: cert && cert.subject ? name(cert.subject) : '(no certificate)',
    issuer: cert && cert.issuer ? name(cert.issuer) : '',
    validTo: cert ? cert.valid_to : null,
    fingerprint256: cert ? cert.fingerprint256 : null,
  };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
}

function stripBrackets(h) {
  return h && h.startsWith('[') ? h.slice(1, -1) : h;
}

function normalizeAddr(a) {
  return a && a.startsWith('::ffff:') ? a.slice(7) : a;
}

module.exports = { SipTransport, DEFAULT_PORT };
