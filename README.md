# WebBrowser

Moteur de recherche, crawler (web **et** réseau onion via Tor) et navigateur texte — le tout dans le terminal.

Tapez `webbrowser` : le terminal se transforme en application plein écran.

```
 WebBrowser  F1 Recherche  F2 Navigateur  F3 Historique  F4 Paramètres          1 254 pages  Tor ●
 › moteur de recherche                                                                     [tout]
───────────────────────────────────────────────────────────────────────────────── 37 résultats ─
▌ 1. Moteur de recherche — Wikipédia
▌ https://fr.wikipedia.org/wiki/Moteur_de_recherche
▌ Un moteur de recherche est une application web permettant de trouver des ressources…
```

## Installation

### Debian, Ubuntu, Linux Mint, Pop!_OS…

Téléchargez `webbrowser_<version>_amd64.deb` depuis la page [Releases](https://github.com/seyko2097/webbrowser/releases), puis :

```bash
sudo apt install ./webbrowser_0.2.0_amd64.deb
webbrowser
```

Node.js est embarqué dans le paquet : il n'y a rien d'autre à installer.
L'application apparaît aussi dans le menu des applications (elle s'ouvre dans un terminal).
Pour la désinstaller : `sudo apt remove webbrowser`.

### Toutes les distributions (archive)

```bash
tar xzf webbrowser-0.2.0-linux-amd64.tar.gz
cd webbrowser-0.2.0-linux-amd64
sudo ./install.sh          # pour tout le système (/opt/webbrowser)
./install.sh --user        # ou seulement pour vous (~/.local), sans sudo
```

### Pour explorer les sites .onion

Installez Tor (`sudo apt install tor`) : WebBrowser utilise son proxy SOCKS sur `127.0.0.1:9050`.
Avec Tor Browser ouvert, réglez plutôt le port sur `9150` (onglet Paramètres, ou `WEBBROWSER_TOR_PORT=9150`).
L'indicateur `Tor ●` dans la barre du haut montre si Tor est joignable.

## Utilisation

| Commande | Effet |
|----------|-------|
| `webbrowser` | ouvre l'interface plein écran |
| `webbrowser chats noirs` | ouvre l'interface avec cette recherche |
| `webbrowser exemple.fr` | ouvre l'interface sur cette page |
| `webbrowser crawl https://exemple.fr -n 200` | explore et indexe un site |
| `webbrowser crawl http://xxxx….onion` | explore un service onion (via Tor) |
| `webbrowser search "phrase exacte" -mot` | recherche en ligne de commande (`--json` possible) |
| `webbrowser open exemple.fr` | affiche le texte d'une page |
| `webbrowser serve` | lance l'API REST sur `http://127.0.0.1:8080/api` |
| `webbrowser stats` · `tor` · `paths` | statistiques, test de Tor, emplacement des données |

`webbrowser --help` et `man webbrowser` détaillent toutes les options.

### Raccourcis de l'interface

| Où | Touches |
|----|---------|
| Partout | `F1`–`F4` (ou `Alt-1`–`Alt-4`) changer d'onglet · `Ctrl-X` arrêter les explorations · `Ctrl-C` quitter |
| Recherche | taper = recherche instantanée · `Entrée` ouvrir l'adresse / aller aux résultats · `Ctrl-R` explorer l'adresse tapée · `Ctrl-O` filtre web/onion |
| Résultats | `↑↓` `jk` · `Entrée` ouvrir · `p` version indexée · `c` explorer le site · `/` nouvelle recherche |
| Navigateur | `12` puis `Entrée` suivre le lien [12] · `o` adresse · `←`/`h` précédent · `→` suivant · `/` chercher dans la page, `n`/`N` · `L` liste des liens · `r` recharger · `i` indexer · `c` explorer · `d` télécharger · `e` navigateur graphique |
| Historique | `Entrée` rouvrir · `x` supprimer · `C` tout effacer · `t` type · `/` filtrer |
| Paramètres | `Entrée`/`Espace` modifier · `←→` ajuster |

### Syntaxe de recherche

| Saisie | Effet |
|--------|-------|
| `mots clés` | tous les mots doivent apparaître (le dernier est cherché en préfixe) |
| `"une phrase"` | expression exacte |
| `-mot` | exclut les pages contenant ce mot |
| `site:exemple.fr` | limite à un site |

La recherche ignore les accents et la casse ; le titre pèse plus que le corps (classement BM25).

### API REST

```
GET    /api/search?q=…&limit=&offset=&network=web|onion&highlight=html
GET    /api/documents?url=…            document indexé
GET    /api/page?url=…                 page chargée par le navigateur
POST   /api/crawl {"urls": […], "maxPages": 50, "maxDepth": 2, "network": "web"|"onion"}
GET    /api/crawl · /api/crawl/:id     suivi des explorations · DELETE pour arrêter
GET    /api/history · DELETE /api/history[/:id]
GET    /api/stats · /api/health
```

En service permanent : `systemctl --user enable --now webbrowser-api`.

## Fonctionnement

- **Crawler** : exploration en largeur, une requête à la fois par site avec délai (respecte `Crawl-delay`),
  `robots.txt` (RFC 9309), `noindex`/`nofollow` (balise meta et en-tête `X-Robots-Tag`), URL canoniques,
  déduplication des URL et des contenus, limite de pages et de profondeur. Les pages déjà indexées
  récemment ne sont pas retéléchargées : leurs liens enregistrés servent à continuer l'exploration.
- **Web** : refuse par défaut localhost et les adresses privées, y compris via DNS (protection SSRF).
- **Onion** : tout passe par Tor avec résolution DNS distante, en-têtes identiques à Tor Browser, aucune
  connexion hors `.onion` ; adresses v3 vérifiées (somme de contrôle) ; liste noire au format Ahmia
  (`/etc/webbrowser/onion-blocklist.txt`) ; les adresses citées en texte brut sont aussi découvertes.
- **Index** : SQLite FTS5 (`node:sqlite`), extraits surlignés, graphe des liens.
- **Navigateur** : client HTTP maison (redirections, gzip/brotli, encodages, cookies, cache, proxy SOCKS5/HTTP).
  Moteur `playwright` optionnel pour les sites qui exigent JavaScript (`npm i playwright`, puis Paramètres).

### Données

| Installé (paquet) | Depuis les sources |
|-------------------|--------------------|
| `~/.local/share/webbrowser/` index et téléchargements | `Data/` |
| `~/.config/webbrowser/settings.json` réglages | `Data/settings.json` |
| `~/.cache/webbrowser/` cache HTTP | `Data/Cache/` |
| `~/.local/state/webbrowser/` journaux | `Logs/` |

`--home DOSSIER` ou `WEBBROWSER_HOME` regroupe tout dans un dossier. Réglages par défaut : `Config/config.js`.

## Développement

Node.js ≥ 22.5, aucune dépendance npm.

```bash
node Src/main.js          # lancer depuis les sources
npm test                  # tests (node:test)
npm run lint              # ESLint
npm run package           # construit dist/*.deb et dist/*.tar.gz
```

Publier une version : `git tag v0.2.0 && git push origin v0.2.0` — le workflow GitHub Actions
construit les paquets et les joint à la release.

```
Src/
├── main.js                  ligne de commande
├── Backend/
│   ├── App.js               assemblage des services, explorations en arrière-plan
│   ├── Crawler/
│   │   ├── Core/            Crawler, Queue, Scheduler, Worker, Deduplicator
│   │   ├── Parsers/         HtmlParser, LinkParser, MetadataParser, RobotsParser
│   │   ├── Onion-Crawler/   OnionCrawler, OnionParser, OnionValidator
│   │   ├── Web-Crawler/     WebCrawler, WebValidator
│   │   └── Indexer/         Indexer, Document, SearchIndex
│   ├── Browser/             Browser, Page, Context (cookies, précédent/suivant), BrowserPool
│   ├── Network/             HttpClient, Proxy (SOCKS5, CONNECT), Tor, Headers
│   ├── Storage/             Database (+ historique), Cache, Files
│   ├── API/                 Server, Routes/, Controllers/
│   └── Utils/               Logger, Validator, Config
└── Frontend/                Terminal (rendu ANSI), App, Search/, Browser/, History/, Settings/
Config/      config.js, liste noire onion
Data/        Cache/, Downloads/, Index/
Packaging/   build.sh, install.sh, lanceur, .desktop, man, service systemd
Tests/       Crawler/, Browser/, Network/, API/, Fixtures/
```
