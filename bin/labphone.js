#!/usr/bin/env node
'use strict';
// LabPhone launcher: starts the local SIP engine + web UI and opens it in the browser.
const http = require('http');
const { spawn } = require('child_process');
const { App } = require('../src/server');
const pkg = require('../package.json');

const HELP = `LabPhone ${pkg.version} - SIP softphone for telecom training

Usage: labphone [options]

  --http-port <n>     Web UI port on 127.0.0.1 (default 8460)
  --sip-port <n>      SIP UDP+TCP listen port (default 5060)
  --tls-port <n>      SIP TLS listen port (default 5061)
  --sip-host <ip>     Address to bind SIP/RTP sockets to (default 0.0.0.0)
  --rtp-ports <a-b>   RTP port range (default 40000-40999)
  --config-dir <dir>  Settings folder (default ~/.config/labphone)
  --strict-ports      Fail instead of picking the next free port
  --no-open           Do not open the browser
  -h, --help          Show this help

Run several phones on one machine by giving each its own --sip-port, --tls-port,
--http-port and --config-dir.`;

function parseArgs(argv) {
  const o = { open: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    switch (a) {
      case '--http-port': o.httpPort = parseInt(next(), 10); break;
      case '--sip-port': o.sipPort = parseInt(next(), 10); break;
      case '--tls-port': o.tlsPort = parseInt(next(), 10); break;
      case '--sip-host': o.sipHost = next(); break;
      case '--rtp-ports': { const [a1, b] = next().split('-').map(Number); o.rtpMin = a1; o.rtpMax = b; break; }
      case '--config-dir': o.configDir = next(); break;
      case '--strict-ports': o.strictPorts = true; break;
      case '--no-open': o.open = false; break;
      case '-h': case '--help': console.log(HELP); process.exit(0); break;
      case '-v': case '--version': console.log(pkg.version); process.exit(0); break;
      default: console.error(`Unknown option ${a}\n\n${HELP}`); process.exit(2);
    }
  }
  return o;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => console.log(`Open ${url} in your browser.`));
    p.unref();
  } catch { console.log(`Open ${url} in your browser.`); }
}

function ping(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/ping', timeout: 800 }, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body).app === 'labphone'); } catch { resolve(false); } });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const port = opts.httpPort || 8460;
  // A desktop launcher click while LabPhone already runs just opens the existing UI.
  if (!opts.configDir && !opts.sipPort && await ping(port)) {
    console.log(`LabPhone is already running at http://127.0.0.1:${port}/`);
    if (opts.open) openBrowser(`http://127.0.0.1:${port}/`);
    return;
  }
  const app = new App(opts);
  try {
    await app.start();
  } catch (e) {
    console.error(`LabPhone failed to start: ${e.message}`);
    if (e.code === 'EACCES') console.error('Ports below 1024 need root; use the default ports or --sip-port 5060.');
    process.exit(1);
  }
  console.log(`LabPhone ${pkg.version} running: ${app.url}`);
  console.log(`Settings: ${app.config.dir}`);
  if (opts.open) openBrowser(app.url);
  let stopping = false;
  const shutdown = async () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('Shutting down (unregistering)...');
    await app.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
})();
