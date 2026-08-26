# Bookmarks

Your bookmarks, one keystroke away.

Self-hosted bookmark manager with instant substring search. Two frontends over
the same vault: a Spotlight-style launcher bar on Linux, and a PWA in the
browser served by the same backend. No dependencies, no accounts anywhere but
your own machine.

## Requirements

Node 24 and Python 3 with GTK3 (`python3-gi`). `mise` is optional and pins both.

## Install

    git clone git@github.com:nochaosio/bookmarks.nochaos.io.git
    cd bookmarks.nochaos.io
    mise install
    bash desktop/install.sh

That installs a systemd user service for the backend on http://127.0.0.1:8787,
the bar on autostart, and Super+Space as the global shortcut. Pass another one
to change it: `bash desktop/install.sh '<Super>b'`.

Open http://127.0.0.1:8787 and sign in with the test account `teste` /
`teste123`, or register your own.

## The bar

Super+Space, type, Enter opens the link. Up and down or Tab navigate, Ctrl+C
copies the URL, Ctrl+R forces a sync, Esc clears the search and closes when the
search is already empty.

The bar reads and never writes: creating, editing and deleting live in the web
UI. It connects to the account in `~/.config/bookmarks/config.json`, so it never
asks anyone to sign in:

    server: http://127.0.0.1:8787
    username: your-user
    password: your-password

After the first run the token is stored there and the password can go.

## The web UI

Up and down navigate, Enter opens, Ctrl+Enter opens in a new tab, `e` edits,
Del deletes, `n` creates, `b` toggles the panel, `/` focuses the search,
Ctrl+C clears it. Type `help` for the rest.

The left panel lists every folder, category and tag in the vault. Sections fold
by clicking their heading. Dragging a folder onto another one nests it, and
dropping it on the Folders heading or on the empty space below the list moves it
back to the root.

Every open counts. The most opened links climb the results, the counter shows
next to the URL, and `insights` in the topbar has opens per day, the most opened
links and the access log for the last 7, 14 or 30 days.

The theme picker carries the four Catppuccin flavours, a matrix one, and
`system`, which follows the desktop.

## Search

The same syntax in the bar, the web UI and the API. Everything is substring,
case and accent insensitive, and terms combine with AND.

    kuber              title, URL, tags, category, folder or description
    #devops            tags only
    @work              category only
    /dev/infra         folder only
    title:grafana      that field only, also url:, description:, cat:, folder:
    "hacker news"      literal phrase
    -grafana           excludes matches

## Import and export

YAML, browser HTML and JSON, in both directions. The YAML groups entries by
folder, so the file is the tree written down:

    folders:
      technology/infrastructure/observability:
      - id: 94b2b47a-...
        title: Grafana
        url: https://grafana.com

Renaming a key renames that folder for everything under it, moving an entry is
a `folder:` line on it, and a key that does not exist yet is created on import.
When importing a file you edited by hand, choose "Use the file": with equal
dates the other modes keep what the vault already has and your edits are
skipped.

## Run it by hand

    mise run server    backend + web UI on http://127.0.0.1:8787
    mise run bar       opens the bar
    mise run test      the whole suite
    mise run up        docker stack (add --profile tls for the phone)

## Layout

    api/        backend: HTTP, SQLite, import/export. Node built-ins only
    web/        the PWA, and the nginx image that serves it in Docker
    proxy/      caddy with TLS, so a phone can install the PWA
    desktop/    the GTK/Tk bar and its installers
    tests/      one suite for all of it: bash tests/run.sh

The search engine is written twice, `web/search.js` and
`desktop/bookmarks_search.py`, so the bar answers offline exactly like the web
does. A parity test compares them on random vaults and queries.

## Where things live

    ~/.local/share/bookmarks/bookmarks.db    the vault
    ~/.local/share/bookmarks/cache.db        the bar's local copy
    ~/.config/bookmarks/config.json          the bar's config
    systemctl --user status bookmarks        the backend

Environment: `BOOKMARKS_PORT`, `BOOKMARKS_HOST`, `BOOKMARKS_DB`,
`BOOKMARKS_SEED=0` to skip the test account, and `BOOKMARKS_COMMIT` /
`BOOKMARKS_DEPLOYED_AT` for a pipeline to stamp the build shown next to the
sync light.

## Images

Locally the backend serves the PWA itself on 8787 and there is no proxy. In
Docker the parts are split, and each one is versioned by the last commit that
touched it, so a frontend release leaves the other two on the tag they had:

    nochaos/bookmarks-api      the backend
    nochaos/bookmarks-web      nginx: the PWA, and /api proxied to the api
    nochaos/bookmarks-proxy    caddy: TLS in front, for the phone

`docker compose up -d --build` brings up api and web on http://localhost:8080.
That is the whole stack for normal use: nginx serves the PWA and proxies /api
to the backend, which is the same origin the service worker needs.

The proxy is the exception, and it is behind a profile:

    BOOKMARKS_SITE=192.168.0.10 docker compose --profile tls up -d --build

It exists for one thing. A PWA only installs, and a service worker only
registers, in a secure context: https or localhost. From a phone over the LAN
you have neither, so caddy issues a certificate from its own CA and serves that
CA at http://<ip>/root.crt for the phone to trust. With a real domain, or a
tunnel that already terminates TLS, you do not need it.

## CI

`.github/workflows/docker.yml` runs the suite, builds the three images, scans
each with trivy and logs into both registries so a stale credential surfaces on
an ordinary push. Publishing is opt in: dispatch the workflow with `push`
checked.
