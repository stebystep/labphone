# Contributing to LabPhone

Thanks for helping. LabPhone is a teaching tool, so readable code matters as much as features.

## Getting started

```bash
git clone https://github.com/stebystep/labphone.git
cd labphone
node bin/labphone.js        # runs from source, opens http://127.0.0.1:8460/
node --test test/*.test.js  # 19 unit + end-to-end tests, ~35 s
```

Needs Node.js 18 or newer and openssl. There is no build step and no npm dependency. Please keep it that way; it is what lets students read and run everything.

Changes to `public/` need only a page reload. Changes to `src/` need a restart.

## Before you open a pull request

- `node --test test/*.test.js` passes.
- If you touched SIP, SDP, RTP or SRTP, add or extend a test. `test/e2e.test.js` runs real calls over sockets.
- Optional but valuable: `npm run test:linux` (Docker) runs everything on Ubuntu 24.04 with Node 18, including interop with a real Asterisk.
- Each source file starts with a comment naming the RFCs it implements. Keep that up to date.
- Explanations shown to students live in `public/sipdocs.js`. Add one when you add a header or method.

## Ideas that would help

- Opus or G.722 codecs
- Attended transfer (`Replaces`), PRACK / 100rel, session timers
- DTLS-SRTP
- ICE/STUN for calls across NAT
- An RPM package for Oracle Linux, RHEL and Fedora

## Reporting problems

Open an issue with your Linux distribution, Node version (`node --version`) and the exported SIP trace. The trace is exported with the **Export** button on the SIP ladder tab. Remove passwords and real phone numbers from it first.

By contributing you agree that your contribution is licensed under the MIT License of this project.
