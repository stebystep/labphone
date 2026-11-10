'use strict';
// SIP message model, parser and serializer (RFC 3261 section 7).
// Written to be readable by students: every helper is small and self-contained.

const COMPACT = {
  v: 'Via', f: 'From', t: 'To', i: 'Call-ID', m: 'Contact', l: 'Content-Length',
  c: 'Content-Type', k: 'Supported', s: 'Subject', e: 'Content-Encoding', o: 'Event',
  r: 'Refer-To', b: 'Referred-By', u: 'Allow-Events', x: 'Session-Expires',
};

const KNOWN = [
  'Via', 'From', 'To', 'Call-ID', 'CSeq', 'Contact', 'Max-Forwards', 'Route', 'Record-Route',
  'Content-Length', 'Content-Type', 'Authorization', 'Proxy-Authorization', 'WWW-Authenticate',
  'Proxy-Authenticate', 'Authentication-Info', 'Expires', 'Min-Expires', 'User-Agent', 'Server',
  'Allow', 'Supported', 'Require', 'Proxy-Require', 'Unsupported', 'Event', 'Subscription-State',
  'Refer-To', 'Referred-By', 'Allow-Events', 'Session-Expires', 'Min-SE', 'Accept', 'Retry-After',
  'Reason', 'Warning', 'Date', 'Timestamp', 'Organization', 'Subject', 'Call-Info', 'Alert-Info',
  'Accept-Encoding', 'Accept-Language', 'Content-Disposition', 'Content-Encoding', 'Content-Language',
  'Error-Info', 'In-Reply-To', 'MIME-Version', 'Priority', 'Reply-To', 'P-Asserted-Identity',
  'P-Preferred-Identity', 'Privacy', 'Path', 'Service-Route', 'RSeq', 'RAck', 'Replaces', 'Diversion',
];
const CANONICAL = Object.fromEntries(KNOWN.map((h) => [h.toLowerCase(), h]));

// Headers whose value may legally be a comma separated list of several values.
const LIST_HEADERS = new Set([
  'via', 'contact', 'route', 'record-route', 'allow', 'supported', 'require', 'proxy-require',
  'unsupported', 'accept', 'path', 'service-route', 'allow-events',
]);

function canonicalName(name) {
  const lower = name.trim().toLowerCase();
  if (lower.length === 1 && COMPACT[lower]) return COMPACT[lower];
  if (CANONICAL[lower]) return CANONICAL[lower];
  return lower.replace(/(^|-)([a-z])/g, (m, d, c) => d + c.toUpperCase());
}

// Split "a, b, <sip:x;p=1,2>" on commas that are not inside quotes or <...>.
function splitList(value) {
  const out = [];
  let cur = '';
  let inQuote = false;
  let angle = 0;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (inQuote) {
      cur += ch;
      if (ch === '\\' && i + 1 < value.length) { cur += value[++i]; continue; }
      if (ch === '"') inQuote = false;
      continue;
    }
    if (ch === '"') { inQuote = true; cur += ch; continue; }
    if (ch === '<') angle++;
    else if (ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && angle === 0) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// ";a=1;b;c=\"x;y\"" -> { a: '1', b: null, c: '"x;y"' }
function parseParams(str) {
  const params = {};
  if (!str) return params;
  const parts = [];
  let cur = '';
  let inQuote = false;
  for (const ch of str) {
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  for (const p of parts) {
    const t = p.trim();
    if (!t) continue;
    const eq = t.indexOf('=');
    if (eq < 0) params[t.toLowerCase()] = null;
    else params[t.slice(0, eq).trim().toLowerCase()] = t.slice(eq + 1).trim();
  }
  return params;
}

function formatParams(params) {
  if (!params) return '';
  return Object.entries(params)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (v === null ? `;${k}` : `;${k}=${v}`))
    .join('');
}

function splitHostPort(hp) {
  let host = hp;
  let port = null;
  if (hp.startsWith('[')) {
    const end = hp.indexOf(']');
    host = hp.slice(0, end + 1);
    const rest = hp.slice(end + 1);
    if (rest.startsWith(':')) port = parseInt(rest.slice(1), 10);
  } else {
    const c = hp.lastIndexOf(':');
    if (c >= 0) {
      host = hp.slice(0, c);
      port = parseInt(hp.slice(c + 1), 10);
    }
  }
  return { host, port: Number.isFinite(port) ? port : null };
}

// sip:alice:secret@example.com:5061;transport=tls?subject=x
function parseUri(str) {
  if (!str) return null;
  const s = String(str).trim();
  const m = /^(sips?):(.*)$/i.exec(s);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  let rest = m[2];
  let headers = '';
  const q = rest.indexOf('?');
  if (q >= 0) { headers = rest.slice(q + 1); rest = rest.slice(0, q); }
  let user = null;
  let password = null;
  const at = rest.lastIndexOf('@');
  let hostAndParams = rest;
  if (at >= 0) {
    user = rest.slice(0, at);
    hostAndParams = rest.slice(at + 1);
    const c = user.indexOf(':');
    if (c >= 0) { password = user.slice(c + 1); user = user.slice(0, c); }
  }
  const sc = hostAndParams.indexOf(';');
  const hp = sc >= 0 ? hostAndParams.slice(0, sc) : hostAndParams;
  const params = parseParams(sc >= 0 ? hostAndParams.slice(sc + 1) : '');
  const { host, port } = splitHostPort(hp);
  if (!host) return null;
  return { scheme, user, password, host: host.toLowerCase(), port, params, headers };
}

function formatUri(u) {
  if (typeof u === 'string') return u;
  let s = `${u.scheme || 'sip'}:`;
  if (u.user) s += u.user + (u.password ? `:${u.password}` : '') + '@';
  s += u.host;
  if (u.port) s += `:${u.port}`;
  s += formatParams(u.params);
  if (u.headers) s += `?${u.headers}`;
  return s;
}

// "Alice" <sip:alice@x>;tag=123   or   sip:alice@x;tag=123
function parseNameAddr(str) {
  const s = String(str || '').trim();
  let display = null;
  let uri;
  let rest = '';
  const lt = s.indexOf('<');
  if (lt >= 0) {
    display = s.slice(0, lt).trim();
    if (display.startsWith('"')) display = display.slice(1, display.lastIndexOf('"')).replace(/\\(.)/g, '$1');
    const gt = s.indexOf('>', lt);
    uri = s.slice(lt + 1, gt < 0 ? undefined : gt).trim();
    rest = gt < 0 ? '' : s.slice(gt + 1);
  } else {
    const sc = s.indexOf(';');
    uri = (sc >= 0 ? s.slice(0, sc) : s).trim();
    rest = sc >= 0 ? s.slice(sc) : '';
  }
  return { display: display || null, uri, params: parseParams(rest.replace(/^\s*;/, '')) };
}

function formatNameAddr(na) {
  const display = na.display ? `"${String(na.display).replace(/(["\\])/g, '\\$1')}" ` : '';
  return `${display}<${typeof na.uri === 'string' ? na.uri : formatUri(na.uri)}>${formatParams(na.params)}`;
}

// SIP/2.0/UDP 10.0.0.1:5060;branch=z9hG4bK776;rport
function parseVia(str) {
  const m = /^SIP\s*\/\s*2\.0\s*\/\s*([A-Za-z]+)\s+([^;\s]+)\s*(.*)$/i.exec(String(str).trim());
  if (!m) return null;
  const { host, port } = splitHostPort(m[2]);
  return { transport: m[1].toUpperCase(), host, port, params: parseParams(m[3].replace(/^;/, '')) };
}

function formatVia(v) {
  return `SIP/2.0/${v.transport} ${v.host}${v.port ? `:${v.port}` : ''}${formatParams(v.params)}`;
}

function parseCSeq(str) {
  const m = /^\s*(\d+)\s+(\S+)/.exec(String(str || ''));
  return m ? { seq: parseInt(m[1], 10), method: m[2].toUpperCase() } : null;
}

class SipMessage {
  constructor() {
    this.method = null; // request only
    this.uri = null; // request only
    this.status = null; // response only
    this.reason = null; // response only
    this.headers = []; // [{ name, value }] in wire order
    this.body = '';
  }

  static request(method, uri) {
    const m = new SipMessage();
    m.method = method.toUpperCase();
    m.uri = uri;
    return m;
  }

  static response(status, reason) {
    const m = new SipMessage();
    m.status = status;
    m.reason = reason || REASONS[status] || 'Unknown';
    return m;
  }

  get isRequest() { return this.method !== null; }
  get isResponse() { return this.status !== null; }

  get(name) {
    const values = this.getAll(name);
    return values.length ? values[0] : undefined;
  }

  getAll(name) {
    const canon = canonicalName(name).toLowerCase();
    const out = [];
    for (const h of this.headers) {
      if (h.name.toLowerCase() !== canon) continue;
      if (LIST_HEADERS.has(canon) && h.value.trim() !== '*') out.push(...splitList(h.value));
      else out.push(h.value);
    }
    return out;
  }

  has(name) { return this.get(name) !== undefined; }

  set(name, value) {
    this.remove(name);
    if (value !== undefined && value !== null) this.add(name, value);
    return this;
  }

  add(name, value) {
    this.headers.push({ name: canonicalName(name), value: String(value) });
    return this;
  }

  prepend(name, value) {
    this.headers.unshift({ name: canonicalName(name), value: String(value) });
    return this;
  }

  remove(name) {
    const canon = canonicalName(name).toLowerCase();
    this.headers = this.headers.filter((h) => h.name.toLowerCase() !== canon);
    return this;
  }

  // Convenience accessors used all over the UA.
  get callId() { return this.get('Call-ID'); }
  get cseq() { return parseCSeq(this.get('CSeq')); }
  get from() { return parseNameAddr(this.get('From')); }
  get to() { return parseNameAddr(this.get('To')); }
  get topVia() { return parseVia(this.get('Via') || ''); }

  clone() {
    const m = new SipMessage();
    Object.assign(m, this, { headers: this.headers.map((h) => ({ ...h })) });
    return m;
  }

  toString() {
    const lines = [this.isRequest ? `${this.method} ${this.uri} SIP/2.0` : `SIP/2.0 ${this.status} ${this.reason}`];
    for (const h of this.headers) {
      if (h.name === 'Content-Length') continue;
      lines.push(`${h.name}: ${h.value}`);
    }
    const body = this.body || '';
    lines.push(`Content-Length: ${Buffer.byteLength(body)}`);
    return `${lines.join('\r\n')}\r\n\r\n${body}`;
  }

  summary() {
    if (this.isRequest) return `${this.method} ${this.uri}`;
    const cs = this.cseq;
    return `${this.status} ${this.reason}${cs ? ` (${cs.method})` : ''}`;
  }
}

function parse(raw) {
  const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
  let sep = buf.indexOf('\r\n\r\n');
  let sepLen = 4;
  if (sep < 0) { sep = buf.indexOf('\n\n'); sepLen = 2; }
  if (sep < 0) { sep = buf.length; sepLen = 0; }
  const head = buf.subarray(0, sep).toString('utf8');
  let bodyBuf = buf.subarray(sep + sepLen);

  const rawLines = head.split(/\r?\n/);
  const lines = [];
  for (const l of rawLines) {
    if (/^[ \t]/.test(l) && lines.length) lines[lines.length - 1] += ` ${l.trim()}`; // header folding
    else if (l.length) lines.push(l);
  }
  if (!lines.length) throw new Error('empty message');

  const first = lines.shift();
  const msg = new SipMessage();
  let m = /^SIP\/2\.0\s+(\d{3})\s*(.*)$/i.exec(first);
  if (m) {
    msg.status = parseInt(m[1], 10);
    msg.reason = m[2] || '';
  } else {
    m = /^([A-Za-z]+)\s+(\S+)\s+SIP\/2\.0\s*$/i.exec(first);
    if (!m) throw new Error(`bad start line: ${first.slice(0, 80)}`);
    msg.method = m[1].toUpperCase();
    msg.uri = m[2];
  }
  for (const l of lines) {
    const c = l.indexOf(':');
    if (c <= 0) throw new Error(`bad header line: ${l.slice(0, 80)}`);
    msg.headers.push({ name: canonicalName(l.slice(0, c)), value: l.slice(c + 1).trim() });
  }
  const cl = msg.get('Content-Length');
  if (cl !== undefined) {
    const n = parseInt(cl, 10);
    if (Number.isFinite(n) && n < bodyBuf.length) bodyBuf = bodyBuf.subarray(0, n);
  }
  msg.body = bodyBuf.toString('utf8');
  return msg;
}

// Splits a TCP/TLS byte stream into SIP messages using Content-Length (RFC 3261 18.3).
// Also understands RFC 5626 keep-alives: "\r\n\r\n" (ping) and "\r\n" (pong).
class StreamParser {
  constructor({ onMessage, onPing, onError }) {
    this.buf = Buffer.alloc(0);
    this.onMessage = onMessage;
    this.onPing = onPing || (() => {});
    this.onError = onError || (() => {});
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      let i = 0;
      while (i < this.buf.length && (this.buf[i] === 13 || this.buf[i] === 10)) i++;
      if (i > 0) {
        if (i >= 4) this.onPing();
        this.buf = this.buf.subarray(i);
      }
      if (!this.buf.length) return;
      const idx = this.buf.indexOf('\r\n\r\n');
      if (idx < 0) {
        if (this.buf.length > 256 * 1024) { this.onError(new Error('header too large')); this.buf = Buffer.alloc(0); }
        return;
      }
      const head = this.buf.subarray(0, idx).toString('utf8');
      const m = /^(?:content-length|l)[ \t]*:[ \t]*(\d+)/im.exec(head);
      const len = m ? parseInt(m[1], 10) : 0;
      if (this.buf.length < idx + 4 + len) return;
      const raw = this.buf.subarray(0, idx + 4 + len);
      this.buf = this.buf.subarray(idx + 4 + len);
      this.onMessage(Buffer.from(raw));
    }
  }
}

const REASONS = {
  100: 'Trying', 180: 'Ringing', 181: 'Call Is Being Forwarded', 182: 'Queued', 183: 'Session Progress',
  200: 'OK', 202: 'Accepted', 300: 'Multiple Choices', 301: 'Moved Permanently', 302: 'Moved Temporarily',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed',
  406: 'Not Acceptable', 407: 'Proxy Authentication Required', 408: 'Request Timeout', 410: 'Gone',
  415: 'Unsupported Media Type', 416: 'Unsupported URI Scheme', 420: 'Bad Extension',
  423: 'Interval Too Brief', 480: 'Temporarily Unavailable', 481: 'Call/Transaction Does Not Exist',
  482: 'Loop Detected', 483: 'Too Many Hops', 484: 'Address Incomplete', 486: 'Busy Here',
  487: 'Request Terminated', 488: 'Not Acceptable Here', 489: 'Bad Event', 491: 'Request Pending',
  500: 'Server Internal Error', 501: 'Not Implemented', 502: 'Bad Gateway', 503: 'Service Unavailable',
  504: 'Server Time-out', 505: 'Version Not Supported', 513: 'Message Too Large',
  600: 'Busy Everywhere', 603: 'Decline', 604: 'Does Not Exist Anywhere', 606: 'Not Acceptable',
};

module.exports = {
  SipMessage, parse, StreamParser, REASONS,
  parseUri, formatUri, parseNameAddr, formatNameAddr, parseVia, formatVia, parseCSeq,
  parseParams, formatParams, splitList, canonicalName, splitHostPort,
};
