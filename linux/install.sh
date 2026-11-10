#!/usr/bin/env bash
# LabPhone installer for Linux.
#   ./linux/install.sh             install for the current user (~/.local, no root needed)
#   ./linux/install.sh --system    install for all users (/opt/labphone, needs sudo)
#   ./linux/install.sh --service   also run LabPhone in the background as a systemd user service
set -euo pipefail

SYSTEM=0
SERVICE=0
for arg in "$@"; do
  case "$arg" in
    --system) SYSTEM=1 ;;
    --service) SERVICE=1 ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# --- prerequisites -------------------------------------------------------------------
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js 18 or newer is required."
  echo "  Debian/Ubuntu:              sudo apt install nodejs"
  echo "  Oracle Linux / RHEL 8, 9:   sudo dnf module enable -y nodejs:20 && sudo dnf install -y nodejs"
  echo "  Fedora:                     sudo dnf install nodejs"
  echo "  Arch:                       sudo pacman -S nodejs"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Node.js $NODE_MAJOR found, but LabPhone needs 18 or newer." >&2
  exit 1
fi
if ! command -v openssl >/dev/null 2>&1; then
  echo "Warning: openssl not found - LabPhone will still work, but cannot accept incoming TLS connections."
fi

if [ "$SYSTEM" = 1 ]; then
  PREFIX=/opt/labphone
  BIN=/usr/local/bin
  APPS=/usr/share/applications
  ICONS=/usr/share/icons/hicolor/scalable/apps
  SUDO=""
  [ "$(id -u)" -ne 0 ] && SUDO="sudo"
else
  PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/labphone"
  BIN="$HOME/.local/bin"
  APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
  ICONS="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
  SUDO=""
fi

echo "Installing LabPhone to $PREFIX"
$SUDO mkdir -p "$PREFIX" "$BIN" "$APPS" "$ICONS"
$SUDO rm -rf "$PREFIX/bin" "$PREFIX/src" "$PREFIX/public"
$SUDO cp -r "$SRC/bin" "$SRC/src" "$SRC/public" "$SRC/package.json" "$PREFIX/"
[ -f "$SRC/README.md" ] && $SUDO cp "$SRC/README.md" "$PREFIX/"
[ -f "$SRC/LICENSE" ] && $SUDO cp "$SRC/LICENSE" "$PREFIX/"
$SUDO chmod 755 "$PREFIX/bin/labphone.js"
$SUDO ln -sf "$PREFIX/bin/labphone.js" "$BIN/labphone"
$SUDO cp "$SRC/public/icon.svg" "$ICONS/labphone.svg"
sed "s#@BIN@#$BIN/labphone#g" "$SRC/linux/labphone.desktop" | $SUDO tee "$APPS/labphone.desktop" >/dev/null
command -v update-desktop-database >/dev/null 2>&1 && $SUDO update-desktop-database "$APPS" >/dev/null 2>&1 || true

if [ "$SERVICE" = 1 ]; then
  UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed "s#@BIN@#$BIN/labphone#g" "$SRC/linux/labphone.service" > "$UNIT_DIR/labphone.service"
  systemctl --user daemon-reload
  systemctl --user enable --now labphone.service
  echo "Service started: systemctl --user status labphone"
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) echo "Note: $BIN is not in your PATH. Add it, or start LabPhone from the application menu." ;;
esac

cat <<EOF

LabPhone installed.
  Start:     labphone            (or "LabPhone" in the application menu)
  Web UI:    http://127.0.0.1:8460/
  Settings:  ~/.config/labphone/

If a firewall is active, allow SIP and RTP:
  ufw (Ubuntu/Debian):
    sudo ufw allow 5060/udp && sudo ufw allow 5060:5061/tcp && sudo ufw allow 40000:40999/udp
  firewalld (Oracle Linux, RHEL, Fedora):
    sudo firewall-cmd --permanent --add-port=5060/udp --add-port=5060-5061/tcp --add-port=40000-40999/udp && sudo firewall-cmd --reload
EOF
