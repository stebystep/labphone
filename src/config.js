'use strict';
// Persistent settings in $XDG_CONFIG_HOME/labphone (default ~/.config/labphone).
// profiles.json holds passwords, so it is written with mode 0600.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_PROFILE } = require('./sip/ua');

function defaultDir() {
  if (process.env.LABPHONE_CONFIG_DIR) return process.env.LABPHONE_CONFIG_DIR;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'labphone');
}

const PROFILE_FIELDS = Object.keys(DEFAULT_PROFILE).concat(['id', 'tlsCaFile', 'tlsCertFile', 'tlsKeyFile']);

function sanitizeProfile(input, existing) {
  const p = { ...DEFAULT_PROFILE, ...(existing || {}) };
  for (const k of PROFILE_FIELDS) if (input[k] !== undefined && k !== 'password') p[k] = input[k];
  if (typeof input.password === 'string' && input.password !== '') p.password = input.password;
  if (input.clearPassword) p.password = '';
  p.id = p.id || crypto.randomBytes(4).toString('hex');
  p.transport = ['udp', 'tcp', 'tls'].includes(p.transport) ? p.transport : 'udp';
  p.srtp = p.srtp === 'sdes' ? 'sdes' : 'off';
  p.dtmfMode = p.dtmfMode === 'info' ? 'info' : 'rfc2833';
  p.expires = Math.max(30, Math.min(86400, parseInt(p.expires, 10) || 300));
  p.keepaliveSec = Math.max(0, Math.min(600, parseInt(p.keepaliveSec, 10) || 0));
  p.codecs = Array.isArray(p.codecs) ? p.codecs.filter((c) => c === 'PCMU' || c === 'PCMA') : ['PCMU', 'PCMA'];
  if (!p.codecs.length) p.codecs = ['PCMU', 'PCMA'];
  for (const k of ['register', 'tlsVerify', 'useSips', 'autoAnswer']) p[k] = !!p[k];
  for (const k of ['name', 'displayName', 'username', 'authUsername', 'domain', 'proxy', 'tlsCaFile', 'tlsCertFile', 'tlsKeyFile']) {
    p[k] = String(p[k] || '').trim().slice(0, 256);
  }
  if (!p.name) p.name = p.username && p.domain ? `${p.username}@${p.domain}` : 'Account';
  return p;
}

class ConfigStore {
  constructor(dir = defaultDir()) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.profilesFile = path.join(dir, 'profiles.json');
    this.historyFile = path.join(dir, 'history.json');
    this.data = readJson(this.profilesFile, { activeId: null, profiles: [] });
    this.history = readJson(this.historyFile, []);
    if (!this.data.profiles.length) {
      const direct = sanitizeProfile({ name: 'Direct IP (no server)', register: false, transport: 'udp' });
      this.data.profiles.push(direct);
      this.data.activeId = direct.id;
      this.save();
    }
  }

  get profiles() { return this.data.profiles; }
  get activeProfile() { return this.profiles.find((p) => p.id === this.data.activeId) || this.profiles[0]; }

  upsert(input) {
    const idx = this.profiles.findIndex((p) => p.id === input.id);
    const p = sanitizeProfile(input, idx >= 0 ? this.profiles[idx] : null);
    if (idx >= 0) this.profiles[idx] = p; else this.profiles.push(p);
    this.save();
    return p;
  }

  remove(id) {
    if (this.profiles.length <= 1) throw new Error('cannot delete the last account');
    this.data.profiles = this.profiles.filter((p) => p.id !== id);
    if (this.data.activeId === id) this.data.activeId = this.profiles[0].id;
    this.save();
  }

  setActive(id) {
    if (!this.profiles.some((p) => p.id === id)) throw new Error('unknown account');
    this.data.activeId = id;
    this.save();
  }

  // What the browser gets: never the password itself.
  publicProfiles() {
    return this.profiles.map(({ password, ...rest }) => ({ ...rest, hasPassword: !!password }));
  }

  addHistory(entry) {
    this.history.unshift(entry);
    this.history = this.history.slice(0, 200);
    writeJson(this.historyFile, this.history);
  }

  clearHistory() {
    this.history = [];
    writeJson(this.historyFile, this.history);
  }

  save() { writeJson(this.profilesFile, this.data, 0o600); }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, data, mode = 0o644) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode });
  fs.renameSync(tmp, file);
}

module.exports = { ConfigStore, sanitizeProfile, defaultDir };
