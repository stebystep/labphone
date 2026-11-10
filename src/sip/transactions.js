'use strict';
// Transaction layer (RFC 3261 section 17), kept small:
//  - client INVITE / non-INVITE transactions with UDP retransmission timers (A/B, E/F)
//  - automatic ACK for non-2xx final responses to INVITE
//  - server transactions that absorb retransmitted requests and replay the last response
const crypto = require('crypto');
const { SipMessage, parseVia } = require('./message');

const T1 = 500;
const T2 = 4000;
const TIMEOUT = 64 * T1;

function newBranch() {
  return `z9hG4bK${crypto.randomBytes(8).toString('hex')}`;
}

function txKey(branch, method) {
  return `${branch}|${method === 'ACK' ? 'INVITE' : method}`;
}

class TransactionLayer {
  constructor(transport) {
    this.transport = transport;
    this.clients = new Map();
    this.servers = new Map();
  }

  // Sends `req` (Via must already carry a branch). Resolves with the final response.
  sendRequest(req, dest, { onProvisional } = {}) {
    const via = parseVia(req.get('Via'));
    const key = txKey(via.params.branch, req.method);
    const isInvite = req.method === 'INVITE';
    const reliable = dest.transport !== 'udp';
    return new Promise((resolve) => {
      const tx = { req, dest, isInvite, state: 'calling', timers: [], connId: null };
      const clear = () => { tx.timers.forEach(clearTimeout); tx.timers = []; };
      const finish = (res) => {
        clear();
        resolve(res);
      };
      tx.onResponse = (res) => {
        if (tx.state === 'completed') {
          if (isInvite && res.status >= 300) this.transport.send(tx.ack, { ...dest, connId: tx.connId }).catch(() => {});
          return;
        }
        if (res.status < 200) {
          if (tx.state === 'calling') {
            clear();
            tx.state = 'proceeding';
            if (!isInvite) { // non-INVITE keeps Timer F running, retransmits every T2 (17.1.2.2)
              if (!reliable) schedule(T2, T2);
              tx.timers.push(setTimeout(timeout, TIMEOUT));
            }
          }
          if (onProvisional) onProvisional(res);
          return;
        }
        if (isInvite && res.status >= 300) {
          tx.ack = buildAckForFailure(req, res);
          this.transport.send(tx.ack, { ...dest, connId: tx.connId }).catch(() => {});
          tx.state = 'completed';
          setTimeout(() => this.clients.delete(key), reliable ? 0 : TIMEOUT).unref();
          finish(res);
          return;
        }
        // 2xx to INVITE: the transaction ends here; the UA core sends the ACK (17.1.1.2).
        tx.state = 'completed';
        this.clients.delete(key);
        finish(res);
      };
      const timeout = () => {
        this.clients.delete(key);
        const r = SipMessage.response(408, 'Request Timeout');
        r.local = true;
        finish(r);
      };
      const schedule = (interval, cap) => {
        const t = setTimeout(() => {
          this.transport.send(req, { ...dest, connId: tx.connId }).catch(() => {});
          schedule(Math.min(interval * 2, cap), cap);
        }, interval);
        tx.timers.push(t);
      };
      this.clients.set(key, tx);
      this.transport.send(req, dest).then((r) => {
        tx.connId = r.connId;
        if (!reliable) schedule(T1, isInvite ? Infinity : T2);
        if (!(isInvite && tx.state !== 'calling')) tx.timers.push(setTimeout(timeout, TIMEOUT));
      }).catch((e) => {
        this.clients.delete(key);
        const r = SipMessage.response(503, `Service Unavailable (${e.message})`);
        r.local = true;
        finish(r);
      });
    });
  }

  // Returns true if the response belonged to a client transaction.
  handleResponse(res) {
    const via = parseVia(res.get('Via') || '');
    const cseq = res.cseq;
    if (!via || !cseq) return false;
    const tx = this.clients.get(txKey(via.params.branch, cseq.method));
    if (!tx) return false;
    tx.onResponse(res);
    return true;
  }

  // Server side. Returns { tx, retransmission } for a request.
  serverTransaction(req, src) {
    const via = parseVia(req.get('Via') || '');
    const branch = via && via.params.branch && via.params.branch.startsWith('z9hG4bK')
      ? via.params.branch
      : `${req.callId}|${req.cseq && req.cseq.seq}|${req.from.params.tag}`;
    const key = txKey(branch, req.method);
    const existing = this.servers.get(key);
    if (existing) {
      if (req.method === 'ACK') {
        existing.acked = true;
        existing.timers.forEach(clearTimeout);
        return { tx: existing, retransmission: true, ack: true };
      }
      if (existing.method === req.method) {
        if (existing.lastResponse) this.transport.send(existing.lastResponse, existing.src).catch(() => {});
        return { tx: existing, retransmission: true };
      }
    }
    if (req.method === 'ACK') return { tx: null, retransmission: false };
    const tx = {
      key, method: req.method, req, src, lastResponse: null, timers: [], acked: false,
      respond: (res) => {
        tx.lastResponse = res;
        tx.timers.forEach(clearTimeout);
        tx.timers = [];
        const p = this.transport.send(res, src).catch(() => {});
        // Non-2xx final responses to INVITE are retransmitted until the ACK arrives (17.2.1).
        if (tx.method === 'INVITE' && res.status >= 300 && src.transport === 'udp') {
          const again = (iv) => tx.timers.push(setTimeout(() => {
            if (tx.acked) return;
            this.transport.send(res, src).catch(() => {});
            again(Math.min(iv * 2, T2));
          }, iv));
          again(T1);
        }
        if (res.status >= 200) setTimeout(() => { tx.timers.forEach(clearTimeout); this.servers.delete(key); }, TIMEOUT).unref();
        return p;
      },
    };
    this.servers.set(key, tx);
    return { tx, retransmission: false };
  }

  // CANCEL shares the branch of the INVITE it cancels (9.2).
  findInviteServerTx(cancel) {
    const via = parseVia(cancel.get('Via') || '');
    return via ? this.servers.get(txKey(via.params.branch, 'INVITE')) : null;
  }
}

// ACK for a non-2xx final response: same branch, same Request-URI, To from the response (17.1.1.3).
function buildAckForFailure(invite, res) {
  const ack = SipMessage.request('ACK', invite.uri);
  ack.add('Via', invite.get('Via'));
  for (const r of invite.getAll('Route')) ack.add('Route', r);
  ack.add('Max-Forwards', '70');
  ack.add('From', invite.get('From'));
  ack.add('To', res.get('To'));
  ack.add('Call-ID', invite.callId);
  ack.add('CSeq', `${invite.cseq.seq} ACK`);
  return ack;
}

module.exports = { TransactionLayer, newBranch, T1, T2, TIMEOUT };
