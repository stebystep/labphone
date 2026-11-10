# Installing LabPhone on Oracle Linux

LabPhone installs in about five minutes on Oracle Linux 8 or 9. LabPhone itself needs no root; `sudo` is only used for Node.js and the firewall.

Tested on Oracle Linux 8.10 and 9.8 with Node.js 20.

## What you need

| Item | Requirement | Notes |
| --- | --- | --- |
| Operating system | Oracle Linux 8 or 9 | Oracle Linux 7 is not supported: Node.js 18 or newer doesn't run on it. |
| Node.js | 18 or newer | Use the `nodejs:20` module from AppStream (below). |
| openssl | any | Creates LabPhone's TLS certificate; already present on most systems. |
| Browser | Chrome, Chromium, Edge or Firefox | It is the phone's screen, microphone and speaker. |
| Headset | recommended | Speakers feed back into the microphone. |
| Permissions | normal user | `sudo` only for Node.js and the firewall. |

## Install

1. Install Node.js 20 and openssl:

   ```bash
   sudo dnf module enable -y nodejs:20
   sudo dnf install -y nodejs openssl
   ```

2. Check that Node.js is 18 or newer (it should print v20.x):

   ```bash
   node --version
   ```

3. Download LabPhone into your home folder, unpack it and run the installer as your normal user (not root):

   ```bash
   cd ~
   curl -LO https://github.com/stebystep/labphone/releases/download/v1.0.0/labphone-1.0.0.tar.gz
   tar -xzf labphone-1.0.0.tar.gz
   cd labphone-1.0.0
   ./linux/install.sh
   ```

4. Check the installation (it should print 1.0.0):

   ```bash
   labphone --version
   ```

The installer puts the program in `~/.local/share/labphone`, the `labphone` command in `~/.local/bin`, and adds LabPhone to the applications menu. If the shell says `labphone: command not found`, open a new terminal so `~/.local/bin` is on your PATH.

To install it for every user of a shared lab PC, run `./linux/install.sh --system` instead. That needs `sudo` and installs to `/opt/labphone`.

The latest version is always on the [releases page](https://github.com/stebystep/labphone/releases).

## Open the firewall

Oracle Linux runs firewalld, which blocks incoming SIP and audio until you open these ports:

```bash
sudo firewall-cmd --permanent --add-port=5060/udp --add-port=5060-5061/tcp --add-port=40000-40999/udp
sudo firewall-cmd --reload
```

| Port | Protocol | Used for |
| --- | --- | --- |
| 5060 | UDP and TCP | SIP signalling |
| 5061 | TCP | SIP over TLS |
| 40000–40999 | UDP | Audio (RTP and RTCP) |
| 8460 | TCP | The web page. It listens only on 127.0.0.1, so don't open it. |

If 5060 is already taken (for example by another softphone), LabPhone moves to the next free pair (5070/5071, 5080/5081, …). It shows the ports in use at the top of the SIP ladder; open those instead.

## First run

1. Run `labphone` in a terminal, or pick **LabPhone** in the applications menu. Your browser opens **http://127.0.0.1:8460/**. Keep the terminal open; Ctrl+C stops LabPhone.
2. Click **Enable audio** at the top right and allow microphone access.
3. Open the **Accounts** tab, click **+ New account**, fill in the fields below and click **Create account**.
4. The status at the top turns green: **Registered 1001@… via TLS 🔒**.

| Field | What to enter | Example |
| --- | --- | --- |
| Username / extension | Your SIP user | `1001` |
| Password | Your SIP password | |
| Domain / registrar | The PBX name or IP | `pbx.lab.local` |
| Outbound proxy | Only if the PBX uses a non-standard port | `pbx.lab.local:5161` |
| Transport | UDP, TCP or TLS. TLS encrypts the signalling. | TLS |
| Media encryption | *Mandatory SDES-SRTP* encrypts the audio. The PBX must support SRTP. | Mandatory |
| Verify server TLS certificate | Turn on if the PBX has a real certificate, or if you have its CA file | On + CA file path |

Use SRTP only together with TLS. Over UDP or TCP the SRTP keys travel in clear text, and LabPhone shows a warning on the call.

The **Direct IP** account needs no server. To call another LabPhone directly, dial `sip:user@192.168.1.20:5061;transport=tls`.

## Test a call

An echo test checks the whole path: you speak, the PBX sends your voice back, and you hear it in your headset.

**On your own PBX:** ask the administrator for the echo-test number and dial it.

**With the bundled lab PBX:** the `lab-pbx` folder is a ready-made Asterisk with TLS and SRTP. It needs Docker (tested). `podman compose` should also work but hasn't been tested.

```bash
cd ~/labphone-1.0.0/lab-pbx
docker compose up -d --build
```

Then create an account with these settings:

* Username `1001`, Password `secret1001`
* Domain `127.0.0.1`, Outbound proxy `127.0.0.1:5161`
* Transport TLS, Media encryption Mandatory

To verify the certificate, also turn on *Verify server TLS certificate* with CA file `~/labphone-1.0.0/lab-pbx/certs/pbx.crt`.

| Dial | What happens |
| --- | --- |
| 600 | Echo test: you hear your own voice |
| 601 | DTMF test: press 1 2 3 on the keypad within 20 s, then it becomes an echo test |
| 602 | A steady tone from the PBX. Checks your speaker without the microphone. |
| 1002 / 1003 | Calls another lab phone (passwords `secret1002`, `secret1003`) |

During the call:

* The **SIP ladder** tab shows every SIP message. Click one to see what each line means.
* The **Media** tab should show the packets sent and received counts rising, with **0** SRTP auth failures.

## Run in the background, update, uninstall

**Start automatically at login.** No terminal window is needed; open http://127.0.0.1:8460/ in the browser.

```bash
cd ~/labphone-1.0.0
./linux/install.sh --service
systemctl --user status labphone
```

**Update:** download and unpack the newer package, then run `./linux/install.sh` again. Accounts and call history in `~/.config/labphone` are kept.

**Uninstall.** Add `--purge` to also delete accounts and history.

```bash
cd ~/labphone-1.0.0
./linux/uninstall.sh
```

## Change the code

The package is the full source: plain JavaScript for Node.js and the browser, with no build step and no npm packages. Edit a file, restart LabPhone, and reload the page.

1. Work in the unpacked folder and run it from there:

   ```bash
   cd ~/labphone-1.0.0
   node bin/labphone.js
   ```

2. After a change: for files in `public/`, reload the browser page. For files in `src/`, stop LabPhone (Ctrl+C) and start it again.
3. Run the tests (19 tests, about 35 s):

   ```bash
   node --test test/*.test.js
   ```

4. Install your changed version with `./linux/install.sh`.

Or clone the repository: `git clone https://github.com/stebystep/labphone.git`. See [CONTRIBUTING.md](../CONTRIBUTING.md) to send changes back. LabPhone is MIT-licensed: you may use, change and share it, as long as the copyright notice stays with the code.

## Troubleshooting

Most problems show up in the **SIP ladder**: its yellow notes explain DNS, TLS and connection errors.

| Symptom | Fix |
| --- | --- |
| `node: command not found`, or a version below 18 | Run the two `dnf` commands in *Install*. `node --version` must print v18 or newer. |
| `labphone: command not found` | Open a new terminal, or run `~/.local/bin/labphone`. |
| Status shows **401** or *credentials rejected* | Check Username, Password and Auth username with your PBX administrator. |
| Status shows **503** or *Cannot reach* | Check Domain/Outbound proxy, Transport and port. Test with `ping` to the PBX. |
| TLS note says *NOT verified* and registration fails | Turn off *Verify server TLS certificate*, or set the CA file that issued the PBX certificate. |
| Call ends with **488 Not Acceptable Here** | One side requires SRTP and the other doesn't. Make *Media encryption* match the PBX. |
| Call connects but no sound either way | Open the firewall ports (*Open the firewall*). Check that the Media tab shows packets received. |
| Other side hears nothing | Click **Enable audio**, allow the microphone, and check that the MIC meter moves. |
| DTMF / IVR ignores key presses | Use the keypad during the call. The PBX must use RFC 4733; otherwise choose SIP INFO in the account. |
| Port 5060 already in use | LabPhone moves to 5070/5071 automatically. Open those ports, or stop the other softphone. |
