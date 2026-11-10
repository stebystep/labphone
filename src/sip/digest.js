'use strict';
// HTTP Digest authentication as used by SIP (RFC 3261 22, RFC 2617, RFC 8760 for SHA-256).
const crypto = require('crypto');

function parseChallenge(header) {
  const m = /^\s*(\w+)\s+([\s\S]*)$/.exec(header || '');
  if (!m) return null;
  const out = { scheme: m[1] };
  const re = /([\w-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]*))/g;
  let p;
  while ((p = re.exec(m[2]))) {
    out[p[1].toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, '$1') : p[3];
  }
  return out;
}

function hashFor(algorithm) {
  const a = String(algorithm || 'MD5').toUpperCase();
  if (a === 'MD5' || a === 'MD5-SESS') return 'md5';
  if (a === 'SHA-256' || a === 'SHA-256-SESS') return 'sha256';
  return null;
}

function H(alg, s) {
  return crypto.createHash(hashFor(alg)).update(s).digest('hex');
}

function isSupported(challenge) {
  return challenge && /^digest$/i.test(challenge.scheme) && hashFor(challenge.algorithm) !== null;
}

// When a server offers several challenges (e.g. SHA-256 and MD5), prefer the strongest one.
function pickChallenge(headers) {
  const parsed = headers.map(parseChallenge).filter(isSupported);
  parsed.sort((a, b) => (hashFor(b.algorithm) === 'sha256') - (hashFor(a.algorithm) === 'sha256'));
  return parsed[0] || null;
}

function computeResponse({ algorithm, realm, nonce, method, uri, username, password, qop, nc, cnonce, body = '' }) {
  const alg = String(algorithm || 'MD5').toUpperCase();
  let ha1 = H(alg, `${username}:${realm}:${password}`);
  if (alg.endsWith('-SESS')) ha1 = H(alg, `${ha1}:${nonce}:${cnonce}`);
  const ha2 = qop === 'auth-int' ? H(alg, `${method}:${uri}:${H(alg, body)}`) : H(alg, `${method}:${uri}`);
  if (qop) return H(alg, `${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`);
  return H(alg, `${ha1}:${nonce}:${ha2}`);
}

function buildAuthorization({ challenge, method, uri, username, password, body = '', nc = 1, cnonce }) {
  const qops = challenge.qop ? challenge.qop.split(',').map((s) => s.trim().toLowerCase()) : [];
  const qop = qops.includes('auth') ? 'auth' : qops.includes('auth-int') ? 'auth-int' : null;
  const ncHex = nc.toString(16).padStart(8, '0');
  const cn = cnonce || crypto.randomBytes(8).toString('hex');
  const response = computeResponse({
    algorithm: challenge.algorithm, realm: challenge.realm, nonce: challenge.nonce,
    method, uri, username, password, qop, nc: ncHex, cnonce: cn, body,
  });
  const parts = [
    `username="${username}"`, `realm="${challenge.realm}"`, `nonce="${challenge.nonce}"`,
    `uri="${uri}"`, `response="${response}"`,
  ];
  if (challenge.algorithm) parts.push(`algorithm=${challenge.algorithm}`);
  if (challenge.opaque !== undefined) parts.push(`opaque="${challenge.opaque}"`);
  if (qop) parts.push(`qop=${qop}`, `nc=${ncHex}`, `cnonce="${cn}"`);
  return `Digest ${parts.join(', ')}`;
}

// Server side check (used by the test registrar and handy for students to read).
function verifyAuthorization(header, { method, password, realm, body = '' }) {
  const a = parseChallenge(header);
  if (!a || !/^digest$/i.test(a.scheme) || a.realm !== realm) return false;
  const expected = computeResponse({
    algorithm: a.algorithm, realm, nonce: a.nonce, method, uri: a.uri,
    username: a.username, password, qop: a.qop, nc: a.nc, cnonce: a.cnonce, body,
  });
  return expected === a.response;
}

module.exports = { parseChallenge, pickChallenge, buildAuthorization, verifyAuthorization, computeResponse };
