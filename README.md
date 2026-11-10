# LabPhone – a SIP softphone for telecom training

LabPhone is a SIP softphone that runs **locally on Linux** and is used from the **browser**. A small Node.js engine on your machine
does the real SIP and RTP work: plain SIP over UDP, TCP or TLS, which any PBX accepts (no WebRTC gateway needed). The web page is the phone's screen,
microphone and speaker.

It is built for teaching. Every SIP message is drawn live on a **ladder diagram**. Click any line of a message and LabPhone explains
it: the method, the response code, the header, the SDP attribute, with the RFC section.

```
 Browser (http://127.0.0.1:8460)            LabPhone engine (node)                     Network
 ┌─────────────────────────────┐   WS    ┌───────────────────────────────┐
 │ dialer · calls · SIP ladder │◄──────►│ SIP UA: REGISTER, INVITE, …   │◄── SIP over UDP/TCP/TLS ──► PBX / phones
 │ mic/speaker (AudioWorklet)  │  PCM   │ RTP/RTCP · G.711 · SRTP · DTMF │◄── RTP or SRTP ──────────►
 └─────────────────────────────┘ 8 kHz  └───────────────────────────────┘
```

## Features

| Area | What LabPhone does |
|---|---|
| Signalling | SIP (RFC 3261) over **UDP, TCP, TLS 1.2/1.3**; `sips:` URIs; DNS SRV → A lookup (RFC 3263); rport (RFC 3581); CRLF keep-alive (RFC 5626) |
| Registration | REGISTER with **Digest auth** (MD5, MD5-sess, SHA-256 / RFC 8760, qop=auth / auth-int), refresh, 423 Min-Expires, re-register after a TLS connection drops |
| Calls | INVITE/ACK/BYE/CANCEL, early media (183), hold/resume with re-INVITE (sendonly/recvonly), 491 glare retry, late offer, several calls at once (auto-hold) |
| Media | RTP + RTCP (SR/SDES/BYE, remote reports), **G.711 µ-law/A-law**, 20 ms packets, jitter/loss statistics, 1 kHz test tone |
| Security | **SDES-SRTP (RFC 4568)** with AES_CM_128_HMAC_SHA1_80 and _32, SRTCP, replay protection; warning when SRTP keys travel over non-TLS signalling; optional TLS server verification with your own CA; client certificates |
| DTMF | RFC 4733/2833 telephone-events or SIP INFO (send and receive) |
| Other | Blind transfer (REFER/NOTIFY, both directions), SIP MESSAGE chat, voicemail indicator (message-summary NOTIFY), OPTIONS, call history, several accounts |
| Teaching | Live ladder per Call-ID, raw message inspector with explanations, TLS handshake/DNS notes in the trace, trace export |

## Download

Get the latest package from [GitHub Releases](https://github.com/stebystep/labphone/releases):

* `labphone-<version>.tar.gz` is for any distribution, including Oracle Linux, RHEL and Fedora.
* `labphone_<version>_all.deb` is for Debian and Ubuntu.

You can also clone the repository:

```bash
git clone https://github.com/stebystep/labphone.git
```

## Install on Linux

**Oracle Linux 8/9 (and RHEL):** follow the step-by-step [Oracle Linux install guide](docs/install-oracle-linux.md).

You need **Node.js 18 or newer** (no npm packages are used) and **openssl** (for the local TLS certificate).

```bash
sudo apt install nodejs openssl          # Debian / Ubuntu
sudo dnf install nodejs openssl          # Fedora
sudo dnf module enable -y nodejs:20 && sudo dnf install -y nodejs openssl   # Oracle Linux / RHEL 8 and 9
```

Then install LabPhone for your user:

```bash
./linux/install.sh
```

Other options:

* `./linux/install.sh --system` installs it for every user of a lab PC into `/opt/labphone`.
* `./linux/install.sh --service` also starts the engine at login as a systemd user service.
* `./linux/build-deb.sh` builds `dist/labphone_1.0.0_all.deb`, which you can deploy to many lab machines with `sudo apt install ./dist/labphone_1.0.0_all.deb`.
* To remove it, run `./linux/uninstall.sh`. Add `--purge` to also delete your settings.

To run it without installing:

```bash
node bin/labphone.js
```

This opens `http://127.0.0.1:8460/`. Click **Enable audio** once to allow microphone access, and use a headset.

### Ports

| Purpose | Default | Notes |
|---|---|---|
| Web UI | 127.0.0.1:8460/tcp | only reachable from this machine |
| SIP UDP + TCP | 5060 | next free port is used if busy (5070, 5080, …) |
| SIP TLS | 5061 | self-signed certificate created in `~/.config/labphone/certs` |
| RTP / RTCP | 40000–40999/udp | even port = RTP, odd = RTCP |

If a firewall is active, open the SIP and RTP ports:

```bash
sudo ufw allow 5060/udp && sudo ufw allow 5060:5061/tcp && sudo ufw allow 40000:40999/udp
# Oracle Linux / RHEL / Fedora (firewalld):
sudo firewall-cmd --permanent --add-port=5060/udp --add-port=5060-5061/tcp --add-port=40000-40999/udp && sudo firewall-cmd --reload
```

### Command line

```
labphone [--http-port 8460] [--sip-port 5060] [--tls-port 5061] [--sip-host 0.0.0.0]
         [--rtp-ports 40000-40999] [--config-dir DIR] [--strict-ports] [--no-open]
```

Two phones can run on one PC, which is handy for lab exercises without a PBX:

```bash
labphone --config-dir ~/.config/labphone-b --http-port 8461 --sip-port 5070 --tls-port 5071 --rtp-ports 41000-41999
```

## Configure an account

Open **Accounts** to set up a registration:

* **Username / extension**, **Password**, and **Domain / registrar**. An **Outbound proxy** is optional.
* **Transport:** UDP, TCP or TLS.
* **Media encryption:** *Mandatory SDES-SRTP* offers `RTP/SAVP` with `a=crypto`. A call that cannot be encrypted is refused with `488`. When this is *Off*, LabPhone still accepts SRTP if the other side offers it.
* **Verify server TLS certificate:** turn this on with a lab CA file (PEM). This teaches certificate validation. With it off, the trace still shows who issued the certificate.

The default **Direct IP** account needs no server. Dial `sip:bob@192.168.1.20:5061;transport=tls` to call another LabPhone directly.

### Asterisk (PJSIP) with TLS + SRTP

```ini
; pjsip.conf
[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:5061
cert_file=/etc/asterisk/keys/asterisk.crt
priv_key_file=/etc/asterisk/keys/asterisk.key
method=tlsv1_2

[1001]
type=endpoint
transport=transport-tls
context=lab
disallow=all
allow=ulaw,alaw
media_encryption=sdes
dtmf_mode=rfc4733
rewrite_contact=yes        ; reuse the phone's TLS connection for incoming calls
direct_media=no
auth=1001
aors=1001

[1001]
type=auth
auth_type=userpass
username=1001
password=change-me

[1001]
type=aor
max_contacts=1
remove_existing=yes
```

In LabPhone, set **Domain** to the PBX address, **Transport** to TLS and **Media encryption** to mandatory.

A complete, tested lab PBX config is in [test/interop/asterisk/](test/interop/asterisk/). It has three phones:

* 1001 and 1002 use TLS with SRTP.
* 1003 uses plain UDP.

It also has three useful extensions:

* `600` is an echo test.
* `601` is a DTMF test: dial 1-2-3 and it turns into an echo test.
* `100X` calls another phone.

### FreeSWITCH

Enable TLS on the internal profile (`tls=true`, port 5061). Then set `rtp_secure_media=mandatory:AES_CM_128_HMAC_SHA1_80` in the dialplan, or `rtp_secure_media=optional` to accept both.

## Lab PBX in Docker

[lab-pbx/](lab-pbx/) runs Asterisk 20 configured for LabPhone. It has:

* SIP on ports 5160 (UDP/TCP) and 5161 (TLS)
* extensions 1001 and 1002 with TLS + SRTP, and 1003 with plain UDP
* `600` echo test, `601` DTMF test, `602` test tone

```bash
cd lab-pbx && docker compose up -d --build
```

By default the PBX is reachable only from the same computer (127.0.0.1). It uses demo passwords (`secret1001`…). Change them in `pjsip.conf.tmpl` before opening it to a network. For a classroom, run `PBX_EXTERNAL_IP=<host LAN IP> PBX_BIND=0.0.0.0 docker compose up -d --build`.

## Exercises it supports

1. **Registration and Digest.** Register with a wrong password and see two `401` responses. Then compare the `response=` hash with your own MD5 calculation.
2. **Transaction vs. dialog.** Place a call, filter the ladder by Call-ID, and compare the Via `branch` (transaction) with the From/To tags (dialog).
3. **CANCEL vs. BYE.** Hang up while the other phone is ringing (you'll see `CANCEL`, then `487`). Then hang up after the call is answered (you'll see `BYE`).
4. **Hold.** Click Hold and read the `a=sendonly` / `a=recvonly` exchange in the re-INVITE.
5. **UDP vs. TLS.** Capture the same call with Wireshark over UDP, then over TLS. Over UDP the `a=crypto` key is readable on the wire. That's why SDES must go over TLS, and the call card warns you about it.
6. **DTMF.** Compare RFC 4733 events in the media statistics with SIP INFO DTMF in the ladder.
7. **Transfer.** Do a blind transfer and follow `REFER` → `202` → `NOTIFY` (sipfrag 100 / 200) → `BYE`.

**Decrypting TLS in Wireshark.** Start LabPhone with `node --tls-keylog=/tmp/labphone-keys.log bin/labphone.js`. In Wireshark, set *TLS → (Pre)-Master-Secret log filename* to that file.

## Development

```bash
npm test             # unit tests (RFC test vectors) + end-to-end calls over real sockets
npm run test:linux   # Docker: Ubuntu 24.04 + Node 18 + Asterisk 20 (see below)
```

`npm run test:linux` builds an Ubuntu 24.04 container ([test/linux/Dockerfile](test/linux/Dockerfile)) with the distribution's own Node.js 18 and Asterisk 20.6. Inside the container it:

1. Runs all tests.
2. Builds and installs the `.deb`, starts the installed `labphone`, and checks the web UI and its Host-header protection.
3. Runs `install.sh` and `uninstall.sh` as a normal user.
4. Runs the Asterisk interop suite: TLS registration with a verified certificate, an SRTP echo test with zero authentication failures, RFC 4733 DTMF recognised by an IVR, a phone-to-phone call over the registered TLS connection with hold, and SRTP-to-RTP bridging.

The code is meant to be read by students; each file starts with a comment naming the RFCs it implements:

```
src/sip/message.js       SIP parser/serializer, TCP stream framing
src/sip/transport.js     UDP/TCP/TLS sockets, DNS SRV, keep-alive
src/sip/transactions.js  client/server transactions, retransmission timers
src/sip/digest.js        Digest authentication
src/sip/sdp.js           SDP offer/answer, a=crypto
src/sip/ua.js            registration, calls, hold, transfer, DTMF, MESSAGE
src/media/rtp-session.js RTP/RTCP, jitter/loss stats, RFC 4733 DTMF
src/media/srtp.js        SRTP/SRTCP (AES-CM + HMAC-SHA1)
src/media/g711.js        µ-law / A-law
src/server.js            local web server + WebSocket bridge
public/                  browser UI, AudioWorklet resampler, SIP explanations
```

## Limitations

* **Codecs:** G.711 only. Opus and G.722 aren't supported.
* **Media:** audio only, no video. SRTP keys are exchanged with SDES only (no DTLS-SRTP or ZRTP).
* **Not yet supported:**
  * attended transfer (`Replaces`)
  * reliable provisional responses (100rel/PRACK)
  * session timers
  * ICE/STUN NAT traversal (LabPhone is meant for LAN or VPN labs)
* **Accounts:** one account is active at a time.
* **Audio:** echo cancellation is limited because audio is played through WebAudio, so use a headset.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests are welcome.

## License

MIT – see [LICENSE](LICENSE). You may use, change and share LabPhone freely; keep the copyright notice.
