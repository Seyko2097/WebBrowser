#!/usr/bin/env bash
# Installe (ou met à jour) le serveur WebBrowser sur Debian / Ubuntu :
#   robot d'exploration continu + page de recherche publique, en service systemd.
#
#   git clone https://github.com/seyko2097/webbrowser && cd webbrowser
#   sudo ./Packaging/server/install.sh --contact "mailto:moi@exemple.fr"
#
# Options :
#   --port N         port HTTP public (défaut 8080)
#   --contact TEXTE  URL ou e-mail ajouté au User-Agent du robot (recommandé)
#   --node CHEMIN    utiliser ce binaire Node.js (>= 22.5) au lieu de télécharger Node 22
#   --no-start       installer sans démarrer le service
# Relancer le script met à jour l'application en conservant les données et la configuration.
set -euo pipefail

PREFIX=/opt/webbrowser
DATA=/var/lib/webbrowser
ETC=/etc/webbrowser
ENV_FILE=$ETC/server.env
UNIT=/etc/systemd/system/webbrowser-server.service
PORT=8080
CONTACT=""
NODE_SRC=""
START=1
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

say() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mErreur :\033[0m %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    --contact) CONTACT="$2"; shift 2 ;;
    --node) NODE_SRC="$2"; shift 2 ;;
    --no-start) START=0; shift ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) die "option inconnue : $1" ;;
  esac
done

[ "$(id -u)" -eq 0 ] || die "lancez ce script avec sudo"
[ -f "$REPO/Src/main.js" ] || die "lancez ce script depuis le dépôt WebBrowser cloné"
case "$PORT" in ''|*[!0-9]*) die "port invalide : $PORT" ;; esac
. /etc/os-release 2>/dev/null || true
case "${ID:-}${ID_LIKE:-}" in
  *debian*|*ubuntu*) ;;
  *) echo "Attention : système non testé (${PRETTY_NAME:-inconnu}), on continue." ;;
esac

case "$(uname -m)" in
  x86_64) NODE_ARCH=x64 ;;
  aarch64|arm64) NODE_ARCH=arm64 ;;
  *) die "architecture non gérée : $(uname -m)" ;;
esac

node_ok() {
  [ -x "$1" ] || return 1
  "$1" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)' 2>/dev/null
}

# ------------------------------------------------------------------ dépendances système
if ! command -v curl >/dev/null || ! command -v xz >/dev/null; then
  say "Installation de curl et xz-utils"
  apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends curl ca-certificates xz-utils >/dev/null
fi

# ------------------------------------------------------------------ Node.js
mkdir -p "$PREFIX"
if [ -n "$NODE_SRC" ]; then
  node_ok "$NODE_SRC" || die "$NODE_SRC n'est pas un Node.js >= 22.5"
  say "Node.js : copie de $NODE_SRC"
  mkdir -p "$PREFIX/node/bin"
  cp "$(readlink -f "$NODE_SRC")" "$PREFIX/node/bin/node.new"
  mv -f "$PREFIX/node/bin/node.new" "$PREFIX/node/bin/node"
elif node_ok "$PREFIX/node/bin/node"; then
  say "Node.js $("$PREFIX/node/bin/node" --version) déjà installé"
else
  say "Téléchargement de Node.js 22 (nodejs.org)"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  BASE=https://nodejs.org/dist/latest-v22.x
  curl -fsSL "$BASE/SHASUMS256.txt" -o "$TMP/SHASUMS256.txt"
  FILE="$(grep -oE "node-v22\.[0-9]+\.[0-9]+-linux-$NODE_ARCH\.tar\.xz" "$TMP/SHASUMS256.txt" | head -1)"
  [ -n "$FILE" ] || die "archive Node.js introuvable pour $NODE_ARCH"
  curl -fSL --progress-bar "$BASE/$FILE" -o "$TMP/$FILE"
  (cd "$TMP" && grep " $FILE\$" SHASUMS256.txt | sha256sum -c --quiet -) || die "empreinte SHA-256 de Node.js incorrecte"
  rm -rf "$PREFIX/node.new"
  mkdir -p "$PREFIX/node.new"
  tar -xJf "$TMP/$FILE" -C "$PREFIX/node.new" --strip-components=1
  rm -rf "$PREFIX/node"
  mv "$PREFIX/node.new" "$PREFIX/node"
fi
NODE="$PREFIX/node/bin/node"
say "Node.js $("$NODE" --version)"

# ------------------------------------------------------------------ application
say "Installation de l'application dans $PREFIX/app"
rm -rf "$PREFIX/app.new"
mkdir -p "$PREFIX/app.new"
cp -R "$REPO/Src" "$REPO/Config" "$REPO/package.json" "$REPO/README.md" "$PREFIX/app.new/"
rm -rf "$PREFIX/app.old"
[ -d "$PREFIX/app" ] && mv "$PREFIX/app" "$PREFIX/app.old"
mv "$PREFIX/app.new" "$PREFIX/app"
rm -rf "$PREFIX/app.old"
VERSION="$("$NODE" -p "require('$PREFIX/app/package.json').version")"

# ------------------------------------------------------------------ utilisateur et dossiers
if ! id webbrowser >/dev/null 2>&1; then
  say "Création de l'utilisateur système « webbrowser »"
  useradd --system --home-dir "$DATA" --shell /usr/sbin/nologin --user-group webbrowser
fi
mkdir -p "$DATA" "$ETC"
chown webbrowser:webbrowser "$DATA"
chmod 750 "$DATA"
[ -f "$ETC/onion-blocklist.txt" ] || cp "$REPO/Config/onion-blocklist.txt" "$ETC/"

# ------------------------------------------------------------------ configuration adaptée à la machine
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
DISK_MB=$(df -Pm "$DATA" | awk 'NR==2 {print $4}')
DB_CACHE=$(( RAM_MB / 4 )); [ "$DB_CACHE" -gt 8192 ] && DB_CACHE=8192; [ "$DB_CACHE" -lt 64 ] && DB_CACHE=64
if [ "$RAM_MB" -ge 16000 ]; then CONC=32; elif [ "$RAM_MB" -ge 4000 ]; then CONC=16; else CONC=6; fi
# On laisse 20 Go (ou 20 %) libres pour le système, la base peut occuper 80 % du reste
RESERVE=$(( DISK_MB / 5 )); [ "$RESERVE" -lt 20480 ] && RESERVE=20480
MAX_DB=$(( (DISK_MB - RESERVE) * 8 / 10 )); [ "$MAX_DB" -lt 1024 ] && MAX_DB=1024
MAX_PAGES=$(( MAX_DB * 1024 / 40 ))   # ~40 Ko par page (texte + index plein texte)
MEM_MAX=$(( RAM_MB * 3 / 4 ))

if [ ! -f "$ENV_FILE" ]; then
  say "Création de $ENV_FILE (clé d'administration générée)"
  TOKEN="$(od -An -tx1 -N32 /dev/urandom | tr -d ' \n')"
  umask 077
  cat > "$ENV_FILE" <<CONF
# Configuration du serveur WebBrowser — modifiez puis : sudo systemctl restart webbrowser-server
WEBBROWSER_HOME=$DATA
WEBBROWSER_SERVER_HOST=0.0.0.0
WEBBROWSER_SERVER_PORT=$PORT
WEBBROWSER_ADMIN_TOKEN=$TOKEN
WEBBROWSER_CONTACT=$CONTACT
WEBBROWSER_SYSTEM_BLOCKLIST=$ETC/onion-blocklist.txt
# Réglages calculés pour cette machine ($RAM_MB Mo de RAM, $DISK_MB Mo de disque libre)
WEBBROWSER_CONCURRENCY=$CONC
WEBBROWSER_DB_CACHE_MB=$DB_CACHE
WEBBROWSER_MAX_DB_MB=$MAX_DB
WEBBROWSER_MAX_PAGES=$MAX_PAGES
# Derrière un proxy inverse HTTPS (Caddy, nginx) : WEBBROWSER_TRUST_PROXY=1 et WEBBROWSER_SERVER_HOST=127.0.0.1
WEBBROWSER_TRUST_PROXY=0
CONF
  umask 022
else
  say "Configuration existante conservée ($ENV_FILE)"
  PORT="$(sed -n 's/^WEBBROWSER_SERVER_PORT=//p' "$ENV_FILE")"
fi
chmod 600 "$ENV_FILE"

# ------------------------------------------------------------------ commande « webbrowser »
cat > /usr/local/bin/webbrowser <<WRAP
#!/bin/sh
# Commandes WebBrowser sur ce serveur (exécutées par l'utilisateur « webbrowser »).
if [ "\$(id -u)" -ne 0 ]; then exec sudo "\$0" "\$@"; fi
set -a; . $ENV_FILE; set +a
exec runuser -u webbrowser -- $NODE $PREFIX/app/Src/main.js "\$@"
WRAP
chmod 755 /usr/local/bin/webbrowser

# ------------------------------------------------------------------ service systemd
CAPS="CapabilityBoundingSet="
[ "$PORT" -lt 1024 ] && CAPS="CapabilityBoundingSet=CAP_NET_BIND_SERVICE
AmbientCapabilities=CAP_NET_BIND_SERVICE"
cat > "$UNIT" <<SERVICE
[Unit]
Description=WebBrowser — robot d'exploration et moteur de recherche
Documentation=https://github.com/seyko2097/webbrowser
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=webbrowser
Group=webbrowser
EnvironmentFile=$ENV_FILE
ExecStart=$NODE $PREFIX/app/Src/main.js server
Restart=always
RestartSec=5
TimeoutStopSec=40
LimitNOFILE=65536
MemoryMax=${MEM_MAX}M
Nice=5
# Sécurité
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ReadWritePaths=$DATA
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
RestrictSUIDSGID=true
RestrictRealtime=true
RestrictNamespaces=true
LockPersonality=true
SystemCallArchitectures=native
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
$CAPS

[Install]
WantedBy=multi-user.target
SERVICE

if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  say "Pare-feu ufw : ouverture du port $PORT"
  ufw allow "$PORT/tcp" >/dev/null
fi

if [ -d /run/systemd/system ]; then
  systemctl daemon-reload
  systemctl enable webbrowser-server >/dev/null 2>&1
  if [ "$START" -eq 1 ]; then
    say "Démarrage du service"
    systemctl restart webbrowser-server
    sleep 2
    systemctl is-active --quiet webbrowser-server || { journalctl -u webbrowser-server -n 30 --no-pager; die "le service n'a pas démarré"; }
  fi
else
  echo "systemd absent : lancez le serveur à la main avec « webbrowser server »."
fi

IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
cat <<DONE

  WebBrowser $VERSION est installé.

  Recherche publique : http://${IP:-IP_DU_VPS}:$PORT
  Ajouter un site    : webbrowser seeds add https://fr.wikipedia.org -n 50000
  État du robot      : webbrowser seeds
  Journal en direct  : journalctl -u webbrowser-server -f
  Configuration      : $ENV_FILE (clé d'administration incluse — ne la partagez pas)
  Mise à jour        : git pull && sudo ./Packaging/server/install.sh

DONE
