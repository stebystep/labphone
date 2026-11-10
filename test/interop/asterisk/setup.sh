#!/usr/bin/env bash
# Configures and starts a local Asterisk (PJSIP) with UDP/TCP/TLS transports and SRTP endpoints.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

mkdir -p /etc/asterisk/keys
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=pbx.lab.test/O=Lab CA" \
  -addext "subjectAltName=DNS:pbx.lab.test,IP:127.0.0.1" \
  -keyout /etc/asterisk/keys/asterisk.key -out /etc/asterisk/keys/asterisk.crt 2>/dev/null
cp /etc/asterisk/keys/asterisk.crt /tmp/asterisk-ca.pem
cp "$HERE/pjsip.conf" "$HERE/extensions.conf" "$HERE/modules.conf" /etc/asterisk/
cat > /etc/asterisk/rtp.conf <<'EOF'
[general]
rtpstart=10000
rtpend=10999
EOF

asterisk -U root -G root 2>/dev/null || asterisk
for _ in $(seq 1 60); do
  if asterisk -rx 'pjsip show transports' 2>/dev/null | grep -q transport-tls; then break; fi
  sleep 0.5
done
asterisk -rx 'core show version'
asterisk -rx 'pjsip show transports' | grep -E 'transport-(udp|tcp|tls)'
