#!/usr/bin/env bash
# Désinstalle le serveur WebBrowser. Les données (/var/lib/webbrowser) et la configuration
# (/etc/webbrowser) sont conservées, sauf avec --purge.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "lancez ce script avec sudo" >&2; exit 1; }
if [ -d /run/systemd/system ]; then
  systemctl disable --now webbrowser-server 2>/dev/null || true
fi
rm -f /etc/systemd/system/webbrowser-server.service /usr/local/bin/webbrowser
[ -d /run/systemd/system ] && systemctl daemon-reload
rm -rf /opt/webbrowser
if [ "${1:-}" = "--purge" ]; then
  rm -rf /var/lib/webbrowser /etc/webbrowser
  userdel webbrowser 2>/dev/null || true
  echo "WebBrowser et toutes ses données ont été supprimés."
else
  echo "WebBrowser désinstallé. Données conservées dans /var/lib/webbrowser (--purge pour tout supprimer)."
fi
