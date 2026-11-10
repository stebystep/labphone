#!/usr/bin/env bash
# Removes LabPhone. Settings in ~/.config/labphone are kept unless --purge is given.
#   ./linux/uninstall.sh [--system] [--purge]
set -euo pipefail
SYSTEM=0
PURGE=0
for arg in "$@"; do
  case "$arg" in
    --system) SYSTEM=1 ;;
    --purge) PURGE=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if systemctl --user list-unit-files labphone.service >/dev/null 2>&1; then
  systemctl --user disable --now labphone.service 2>/dev/null || true
  rm -f "${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user/labphone.service"
  systemctl --user daemon-reload 2>/dev/null || true
fi

if [ "$SYSTEM" = 1 ]; then
  SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"
  $SUDO rm -rf /opt/labphone /usr/local/bin/labphone /usr/share/applications/labphone.desktop /usr/share/icons/hicolor/scalable/apps/labphone.svg
else
  D="${XDG_DATA_HOME:-$HOME/.local/share}"
  rm -rf "$D/labphone" "$HOME/.local/bin/labphone" "$D/applications/labphone.desktop" "$D/icons/hicolor/scalable/apps/labphone.svg"
fi

if [ "$PURGE" = 1 ]; then
  rm -rf "${XDG_CONFIG_HOME:-$HOME/.config}/labphone"
  echo "Settings removed."
fi
echo "LabPhone uninstalled."
