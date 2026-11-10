'use strict';
// Creates a self-signed certificate for the local TLS listener (needed for incoming TLS
// connections, e.g. direct IP-to-IP calls between two LabPhones). Uses the openssl CLI.
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function ensureSelfSigned(dir) {
  const certFile = path.join(dir, 'cert.pem');
  const keyFile = path.join(dir, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), certFile, keyFile, created: false };
  }
  fs.mkdirSync(dir, { recursive: true });
  const host = os.hostname();
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
    '-days', '825', '-subj', `/CN=${host}/O=LabPhone`,
    '-addext', `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
    '-keyout', keyFile, '-out', certFile,
  ], { stdio: 'ignore' });
  fs.chmodSync(keyFile, 0o600);
  return { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile), certFile, keyFile, created: true };
}

module.exports = { ensureSelfSigned };
