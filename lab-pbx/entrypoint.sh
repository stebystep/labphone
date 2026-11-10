#!/bin/sh
# Starts the lab Asterisk. PBX_EXTERNAL_IP is the address phones use to reach this PBX:
# 127.0.0.1 for a phone on the same computer, or the host's LAN IP for a classroom.
set -e
IP="${PBX_EXTERNAL_IP:-127.0.0.1}"
mkdir -p /etc/asterisk/keys /certs
if [ ! -f /certs/pbx.crt ]; then
  echo "Creating TLS certificate for ${IP}"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=LabPBX/O=LabPhone lab" \
    -addext "subjectAltName=IP:${IP},IP:127.0.0.1,DNS:localhost" \
    -keyout /certs/pbx.key -out /certs/pbx.crt 2>/dev/null
fi
cp /certs/pbx.crt /etc/asterisk/keys/asterisk.crt
cp /certs/pbx.key /etc/asterisk/keys/asterisk.key
sed "s/@EXTERNAL_IP@/${IP}/g" /lab/pjsip.conf.tmpl > /etc/asterisk/pjsip.conf
cp /lab/extensions.conf /lab/modules.conf /lab/rtp.conf /etc/asterisk/
exec asterisk -f -U root -G root -vvv
