#!/usr/bin/env bash
# Builds dist/labphone_<version>_all.deb (architecture independent: it is plain JavaScript).
# Needs dpkg-deb (Debian/Ubuntu: sudo apt install dpkg-dev).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="$(node -p "require('$SRC/package.json').version")"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
PKG="$STAGE/labphone_${VERSION}_all"

mkdir -p "$PKG/DEBIAN" "$PKG/opt/labphone" "$PKG/usr/bin" "$PKG/usr/share/applications" \
  "$PKG/usr/share/icons/hicolor/scalable/apps" "$PKG/usr/lib/systemd/user" "$PKG/usr/share/doc/labphone"

cp -r "$SRC/bin" "$SRC/src" "$SRC/public" "$SRC/package.json" "$PKG/opt/labphone/"
chmod 755 "$PKG/opt/labphone/bin/labphone.js"
ln -s /opt/labphone/bin/labphone.js "$PKG/usr/bin/labphone"
sed "s#@BIN@#/usr/bin/labphone#g" "$SRC/linux/labphone.desktop" > "$PKG/usr/share/applications/labphone.desktop"
sed "s#@BIN@#/usr/bin/labphone#g" "$SRC/linux/labphone.service" > "$PKG/usr/lib/systemd/user/labphone.service"
cp "$SRC/public/icon.svg" "$PKG/usr/share/icons/hicolor/scalable/apps/labphone.svg"
[ -f "$SRC/README.md" ] && cp "$SRC/README.md" "$PKG/usr/share/doc/labphone/"
[ -f "$SRC/LICENSE" ] && cp "$SRC/LICENSE" "$PKG/usr/share/doc/labphone/copyright"

cat > "$PKG/DEBIAN/control" <<EOF
Package: labphone
Version: $VERSION
Section: comm
Priority: optional
Architecture: all
Depends: nodejs (>= 18), openssl
Recommends: xdg-utils
Maintainer: LabPhone <labphone@localhost>
Description: SIP softphone for telecom training
 Browser-based SIP client that runs locally. SIP over UDP, TCP and TLS,
 SDES-SRTP media encryption, G.711, RFC 4733 DTMF, hold, transfer,
 and a live SIP ladder diagram with explanations of every header.
EOF

cat > "$PKG/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
exit 0
EOF
chmod 755 "$PKG/DEBIAN/postinst"

mkdir -p "$SRC/dist"
dpkg-deb --root-owner-group --build "$PKG" "$SRC/dist/labphone_${VERSION}_all.deb"
echo "Built $SRC/dist/labphone_${VERSION}_all.deb"
echo "Install with: sudo apt install ./dist/labphone_${VERSION}_all.deb"
