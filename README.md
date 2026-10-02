# WebBrowser
Browser + Crawler 

## searchtui — moteur de recherche dans le terminal

Un petit moteur de recherche complet, **sans aucune dépendance** (Python ≥ 3.10, stdlib uniquement) :

- **Crawler** : exploration en largeur, respect de `robots.txt`, délai entre requêtes, limite de pages, reste sur le même domaine par défaut.
- **Index** : SQLite FTS5, classement BM25 (le titre pèse plus que le corps), recherche insensible à la casse et aux accents.
- **TUI** (curses) : recherche instantanée pendant la frappe, extraits avec mots surlignés, lecteur de page intégré, exploration lancée depuis l'interface.

### Utilisation

```bash
# Interface interactive
python3 -m searchtui

# Indexer un site depuis la ligne de commande
python3 -m searchtui crawl https://docs.python.org/fr/3/ --max-pages 200

# Recherche non interactive
python3 -m searchtui search moteur de recherche

# Nombre de pages indexées
python3 -m searchtui stats
```

L'index est stocké dans `~/.searchtui/index.db` (changer avec `--db fichier.db`).

Dans l'interface, tapez une URL puis **Entrée** pour l'explorer et l'indexer en arrière-plan
(`--max-pages` et `--any-domain` sur la commande `tui` règlent l'exploration).

### Syntaxe de recherche

| Saisie           | Effet                                   |
|------------------|-----------------------------------------|
| `mots clés`      | tous les mots doivent apparaître        |
| `"une phrase"`   | expression exacte                       |
| `-mot`           | exclut les pages contenant ce mot       |
| `pyth`           | le dernier mot est cherché en préfixe   |

### Raccourcis

| Écran     | Touches |
|-----------|---------|
| Recherche | `Entrée` résultats / explorer l'URL · `↓`/`Tab` résultats · `Ctrl-U` effacer · `Ctrl-W` effacer un mot · `Ctrl-X` arrêter l'exploration · `Ctrl-C` quitter |
| Résultats | `↑↓`/`jk` naviguer · `Entrée`/`→` lire · `o` ouvrir dans le navigateur · `/` chercher · `q` quitter |
| Lecteur   | `↑↓`/`jk`, `PgUp`/`PgDn`/`Espace` défiler · `n`/`N` occurrence suivante/précédente · `o` navigateur · `q`/`Échap`/`←` retour |

### Tests

```bash
python3 -m unittest discover -s tests -t .
```
