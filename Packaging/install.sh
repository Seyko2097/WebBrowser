#!/bin/sh
# Installation depuis l'archive .tar.gz (toutes distributions Linux).
#   sudo ./install.sh          → /opt/webbrowser + /usr/local/bin/webbrowser
#   ./install.sh --user        → ~/.local/lib/webbrowser + ~/.local/bin/webbrowser
set -eu
HERE="$(cd "$(dirname "$0")" && pwd)"

if [ "${1:-}" = "--user" ]; then
  PREFIX="$HOME/.local/lib/webbrowser"
  BIN="$HOME/.local/bin"
  SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"
  MAN="$SHARE/man/man1"
else
  if [ "$(id -u)" -ne 0 ]; then
    echo "Lancez « sudo ./install.sh » (installation système) ou « ./install.sh --user »." >&2
    exit 1
  fi
  PREFIX="/opt/webbrowser"
  BIN="/usr/local/bin"
  SHARE="/usr/local/share"
  MAN="$SHARE/man/man1"
  mkdir -p /etc/webbrowser
  [ -f /etc/webbrowser/onion-blocklist.txt ] || cp "$HERE/etc/onion-blocklist.txt" /etc/webbrowser/
  [ -f /etc/webbrowser/config.json ] || cp "$HERE/etc/config.json" /etc/webbrowser/
fi

rm -rf "$PREFIX"
mkdir -p "$PREFIX" "$BIN" "$SHARE/applications" "$SHARE/icons/hicolor/scalable/apps" "$MAN"
cp -R "$HERE/lib/." "$PREFIX/"
sed "s#@PREFIX@#$PREFIX#" "$HERE/webbrowser.sh" > "$BIN/webbrowser"
chmod 755 "$BIN/webbrowser" "$PREFIX/node"
cp "$HERE/webbrowser.desktop" "$SHARE/applications/"
cp "$HERE/webbrowser.svg" "$SHARE/icons/hicolor/scalable/apps/"
gzip -9 -c "$HERE/webbrowser.1" > "$MAN/webbrowser.1.gz"
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$SHARE/applications" 2>/dev/null || true

echo "WebBrowser installé dans $PREFIX"
echo "Lancez-le avec : webbrowser"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "Ajoutez $BIN à votre PATH." ;; esac
