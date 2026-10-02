#!/bin/sh
# Lanceur de WebBrowser : utilise le Node.js embarqué dans le paquet.
# Les données de l'utilisateur vont dans ~/.local/share/webbrowser (mode « system »).
PREFIX="@PREFIX@"
export WEBBROWSER_MODE="${WEBBROWSER_MODE:-system}"
exec "$PREFIX/node" "$PREFIX/app/Src/main.js" "$@"
