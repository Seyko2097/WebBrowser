#!/bin/sh
# Désinstallation d'une installation faite avec install.sh (les données de l'utilisateur sont conservées).
set -eu
if [ "${1:-}" = "--user" ]; then
  PREFIX="$HOME/.local/lib/webbrowser"; BIN="$HOME/.local/bin"; SHARE="${XDG_DATA_HOME:-$HOME/.local/share}"
else
  PREFIX="/opt/webbrowser"; BIN="/usr/local/bin"; SHARE="/usr/local/share"
fi
rm -rf "$PREFIX"
rm -f "$BIN/webbrowser" "$SHARE/applications/webbrowser.desktop" \
  "$SHARE/icons/hicolor/scalable/apps/webbrowser.svg" "$SHARE/man/man1/webbrowser.1.gz"
echo "WebBrowser désinstallé. Vos données restent dans ~/.local/share/webbrowser (supprimez-les à la main si besoin)."
