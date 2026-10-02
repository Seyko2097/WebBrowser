#!/bin/sh
# Construit les paquets d'installation dans dist/ :
#   - webbrowser_<version>_<arch>.deb         (Debian, Ubuntu, Mint, Pop!_OS…)
#   - webbrowser-<version>-linux-<arch>.tar.gz (toutes distributions, avec install.sh)
# Node.js est embarqué : rien d'autre à installer sur la machine cible.
# Variables : NODE_BIN (binaire node à embarquer, défaut : celui qui exécute ce script).
set -eu
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
VERSION="$(node -p "require('./package.json').version")"
NODE_BIN="${NODE_BIN:-$(node -p 'process.execPath')}"
NODE_BIN="$(readlink -f "$NODE_BIN")"
NODE_VERSION="$("$NODE_BIN" -p 'process.versions.node')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(echo "$NODE_VERSION" | cut -d. -f2)"
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 5 ]; }; then
  echo "Node.js >= 22.5 requis pour l'embarquer (trouvé $NODE_VERSION)." >&2
  exit 1
fi
case "$("$NODE_BIN" -p 'process.arch')" in
  x64) ARCH=amd64 ;;
  arm64) ARCH=arm64 ;;
  arm) ARCH=armhf ;;
  *) echo "architecture non gérée" >&2; exit 1 ;;
esac

DIST="$ROOT/dist"
WORK="$DIST/build"
rm -rf "$WORK"
mkdir -p "$WORK"

# --- Contenu de l'application (sans tests, données ni fichiers de développement)
APP="$WORK/app"
mkdir -p "$APP"
cp -R Src Config package.json README.md "$APP/"
cp "$NODE_BIN" "$WORK/node"
strip "$WORK/node" 2>/dev/null || true

# ===================================================================== .deb
PKG="$WORK/deb"
LIB="$PKG/usr/lib/webbrowser"
mkdir -p "$LIB" "$PKG/usr/bin" "$PKG/usr/share/applications" "$PKG/usr/share/icons/hicolor/scalable/apps" \
  "$PKG/usr/share/man/man1" "$PKG/usr/share/doc/webbrowser" "$PKG/usr/lib/systemd/user" "$PKG/etc/webbrowser" "$PKG/DEBIAN"
cp -R "$APP" "$LIB/app"
cp "$WORK/node" "$LIB/node"
sed "s#@PREFIX@#/usr/lib/webbrowser#" Packaging/webbrowser.sh > "$PKG/usr/bin/webbrowser"
cp Packaging/webbrowser.desktop "$PKG/usr/share/applications/"
cp Packaging/webbrowser.svg "$PKG/usr/share/icons/hicolor/scalable/apps/"
cp Packaging/webbrowser-api.service "$PKG/usr/lib/systemd/user/"
sed "s/@VERSION@/$VERSION/" Packaging/webbrowser.1 | gzip -9n > "$PKG/usr/share/man/man1/webbrowser.1.gz"
cp Config/onion-blocklist.txt "$PKG/etc/webbrowser/"
echo '{}' > "$PKG/etc/webbrowser/config.json"
cp README.md "$PKG/usr/share/doc/webbrowser/"
cat > "$PKG/usr/share/doc/webbrowser/copyright" <<COPY
Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/
Upstream-Name: webbrowser
Source: https://github.com/seyko2097/webbrowser

Files: *
License: MIT

Files: usr/lib/webbrowser/node
Copyright: Node.js contributors
License: MIT and others, see https://github.com/nodejs/node/blob/main/LICENSE
COPY
find "$PKG" -type d -exec chmod 755 {} +
find "$PKG" -type f -exec chmod 644 {} +
chmod 755 "$PKG/usr/bin/webbrowser" "$LIB/node" "$LIB/app/Src/main.js"

SIZE="$(du -sk "$PKG" | cut -f1)"
cat > "$PKG/DEBIAN/control" <<CTRL
Package: webbrowser
Version: $VERSION
Section: web
Priority: optional
Architecture: $ARCH
Maintainer: WebBrowser <noreply@github.com>
Depends: libc6 (>= 2.28), libstdc++6 (>= 10), libgcc-s1
Recommends: tor, xdg-utils
Installed-Size: $SIZE
Homepage: https://github.com/seyko2097/webbrowser
Description: moteur de recherche, crawler et navigateur pour le terminal
 Interface plein écran (lancez « webbrowser ») pour rechercher dans un index
 local, explorer des sites web et des services onion via Tor, et lire les
 pages en mode texte. Inclut une API REST (webbrowser serve).
 Node.js $NODE_VERSION est embarqué dans le paquet.
CTRL
printf '/etc/webbrowser/config.json\n/etc/webbrowser/onion-blocklist.txt\n' > "$PKG/DEBIAN/conffiles"
cat > "$PKG/DEBIAN/postinst" <<'POST'
#!/bin/sh
set -e
if [ "$1" = "configure" ]; then
  command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
  command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q /usr/share/icons/hicolor || true
  command -v mandb >/dev/null 2>&1 && mandb -q 2>/dev/null || true
fi
exit 0
POST
cp "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"
chmod 755 "$PKG/DEBIAN/postinst" "$PKG/DEBIAN/postrm"

DEB="$DIST/webbrowser_${VERSION}_${ARCH}.deb"
dpkg-deb --root-owner-group -Zxz --build "$PKG" "$DEB" >/dev/null
echo "Paquet Debian : $DEB"

# ===================================================================== .tar.gz
TARNAME="webbrowser-$VERSION-linux-$ARCH"
TARDIR="$WORK/$TARNAME"
mkdir -p "$TARDIR/lib" "$TARDIR/etc"
cp -R "$APP" "$TARDIR/lib/app"
cp "$WORK/node" "$TARDIR/lib/node"
cp Packaging/install.sh Packaging/uninstall.sh Packaging/webbrowser.sh Packaging/webbrowser.desktop \
  Packaging/webbrowser.svg "$TARDIR/"
sed "s/@VERSION@/$VERSION/" Packaging/webbrowser.1 > "$TARDIR/webbrowser.1"
cp Config/onion-blocklist.txt "$TARDIR/etc/"
echo '{}' > "$TARDIR/etc/config.json"
chmod 755 "$TARDIR/install.sh" "$TARDIR/uninstall.sh"
tar -C "$WORK" -czf "$DIST/$TARNAME.tar.gz" "$TARNAME"
echo "Archive       : $DIST/$TARNAME.tar.gz"

rm -rf "$WORK"
