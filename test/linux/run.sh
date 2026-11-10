#!/usr/bin/env bash
# Runs inside the Linux test container (see Dockerfile): tests, packaging, install, Asterisk interop.
set -euo pipefail
cd /src
step() { printf '\n=== %s\n' "$*"; }

step "Platform: $(. /etc/os-release; echo "$PRETTY_NAME") $(uname -m), Node $(node --version), $(openssl version)"

step "Unit + end-to-end tests"
node --test test/*.test.js

step "Build .deb"
./linux/build-deb.sh
step "Install .deb"
dpkg -i dist/labphone_*_all.deb
dpkg -L labphone | grep -E 'bin/labphone|\.desktop|\.service|\.svg'

step "Start installed labphone and query the web UI"
labphone --no-open --config-dir /tmp/lp-deb > /tmp/lp-deb.log 2>&1 &
PID=$!
for _ in $(seq 1 50); do curl -fs http://127.0.0.1:8460/api/ping && break; sleep 0.2; done
echo
curl -fs http://127.0.0.1:8460/ | grep -o '<title>[^<]*</title>'
curl -s -o /dev/null -w 'foreign Host header -> HTTP %{http_code}\n' -H 'Host: evil.example:8460' http://127.0.0.1:8460/
ls -l /tmp/lp-deb/profiles.json /tmp/lp-deb/certs/
kill -INT "$PID"; wait "$PID" || true
cat /tmp/lp-deb.log

step "User install script as a normal user"
useradd -m student
su student -c 'bash /src/linux/install.sh' | tail -4
su student -c '~/.local/bin/labphone --version'
su student -c 'grep ^Exec ~/.local/share/applications/labphone.desktop'
su student -c 'bash /src/linux/uninstall.sh --purge'

step "Asterisk TLS + SRTP interop"
bash test/interop/asterisk/setup.sh
node --test test/interop/asterisk.test.js

step "ALL LINUX CHECKS PASSED"
