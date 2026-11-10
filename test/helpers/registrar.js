'use strict';
// Minimal registrar used by the tests: digest-authenticated REGISTER over UDP/TCP/TLS.
const crypto = require('crypto');
const { SipTransport } = require('../../src/sip/transport');
const { SipMessage, parseNameAddr } = require('../../src/sip/message');
const { verifyAuthorization } = require('../../src/sip/digest');

class TestRegistrar {
  constructor({ sipPort, tlsPort, tls, users, realm = 'lab.test', algorithm = 'MD5' }) {
    this.transport = new SipTransport({ bindHost: '127.0.0.1', sipPort, tlsPort, tlsServer: tls });
    this.users = users;
    this.realm = realm;
    this.algorithm = algorithm;
    this.bindings = new Map();
    this.log = [];
    this.transport.on('message', (m, src) => this.onMessage(m, src));
  }

  start() { return this.transport.start(); }
  stop() { return this.transport.stop(); }

  reply(req, src, status, reason, extra = {}) {
    const res = SipMessage.response(status, reason);
    for (const v of req.getAll('Via')) res.add('Via', v);
    res.add('From', req.get('From'));
    const to = parseNameAddr(req.get('To'));
    if (status >= 200 && !to.params.tag) to.params.tag = 'reg1';
    res.add('To', `<${to.uri}>;tag=${to.params.tag}`);
    res.add('Call-ID', req.callId);
    res.add('CSeq', req.get('CSeq'));
    for (const [k, v] of Object.entries(extra)) res.add(k, v);
    this.transport.send(res, src);
  }

  onMessage(req, src) {
    if (!req.isRequest || req.method !== 'REGISTER') return;
    this.log.push({ src, req });
    const auth = req.get('Authorization');
    const user = req.to.uri.replace(/^sips?:/, '').split('@')[0];
    const password = this.users[user];
    if (!auth || !verifyAuthorization(auth, { method: 'REGISTER', password, realm: this.realm })) {
      const nonce = crypto.randomBytes(8).toString('hex');
      this.reply(req, src, 401, 'Unauthorized', {
        'WWW-Authenticate': `Digest realm="${this.realm}", nonce="${nonce}", algorithm=${this.algorithm}, qop="auth"`,
      });
      return;
    }
    const contact = req.get('Contact');
    const expires = parseInt(parseNameAddr(contact).params.expires || req.get('Expires') || '3600', 10);
    if (expires === 0) this.bindings.delete(user); else this.bindings.set(user, { contact, src });
    this.reply(req, src, 200, 'OK', expires ? { Contact: `${parseNameAddr(contact).uri.replace(/^/, '<')}>;expires=${Math.min(expires, 120)}` } : {});
  }
}

module.exports = { TestRegistrar };
