# Bookmarks

Bookmark manager with instant substring search, in two frontends over the same vault:

* **Bar**: a Spotlight-style launcher for your bookmarks, opened by a global shortcut (Linux, GTK3).
* **Web UI**: the whole vault in the browser, served by the backend.

## Requirements

* Node 24
* Python 3 with GTK3 (`python3-gi`)
* `mise` (optional, pins the versions)

## Install

```bash
git clone git@github.com:nochaosio/bookmarks.nochaos.io.git
cd bookmarks.nochaos.io
mise install
bash desktop/install.sh
```

This sets up a systemd user service for the backend on `http://127.0.0.1:8787`,
the bar daemon on autostart, and the global shortcut `Super+Space`.

Another shortcut:

```bash
bash desktop/install.sh '<Super>b'
```

## Usage

Open `http://127.0.0.1:8787` and log in with the test account `teste` / `teste123`,
or register your own.

Press `Super+Space` to open the bar, type, press `Enter` to open the link.

### Bar keys

| Key | Action |
|---|---|
| `↑` `↓` / `Tab` | navigate |
| `Enter` | open in the browser |
| `Ctrl+C` | copy the URL |
| `Ctrl+D` | delete the bookmark |
| `Ctrl+R` | force sync |
| `Esc` | clear the search, close when empty |

Add a bookmark without leaving the bar by starting with `+`:

```
+ https://fly.io simple deploy #cloud #deploy @work /tools
```

### Web keys

`↑` `↓` navigate, `Enter` open, `e` edit, `Del` delete, `n` new, `b` panel, `/` focus search,
`Ctrl+C` clear the search, `Esc` close what is open. Type `help` (or click **help**)
for the whole list without leaving the page.

### Panel

The left panel lists every folder, category and tag in the vault. Each section
folds by clicking its heading, folders expand and collapse in bulk, and
**dragging a folder onto another nests it**, rewriting the path of everything
below it.

### Usage ranking

Every time a bookmark is opened (`Enter`, `Ctrl+Enter`, a click, or the bar) the
count goes up and the link climbs the results. The counter shows next to the URL,
and **insights** in the topbar has the opens per day, the most opened links and
the access log for the last 7, 14 or 30 days.

### Themes

The topbar picker carries the four Catppuccin flavours (latte, frappé,
macchiato, mocha), a matrix one and `system`, which follows the desktop.
The choice is per browser and survives a reload.

### Search

Same syntax in the bar, the web UI and the API. Everything is substring,
case and accent insensitive.

| Query | Matches |
|---|---|
| `kuber` | title, URL, tags, category, folder or description |
| `#devops` | tags only |
| `@work` | category only |
| `/dev/infra` | folder only |
| `title:grafana` | title only |
| `url:ycombinator` | URL only |
| `"hacker news"` | literal phrase |
| `-grafana` | excludes matches |

Terms combine with AND: `#devops @work -grafana`.

## Run manually

```bash
mise run server    # backend + web UI on http://127.0.0.1:8787
mise run bar       # open the bar
mise run test      # the whole suite
```

## Where things live

| What | Where |
|---|---|
| Vault (server) | `~/.local/share/bookmarks/bookmarks.db` |
| Bar cache | `~/.local/share/bookmarks/cache.db` |
| Bar config | `~/.config/bookmarks/config.json` |
| Backend service | `systemctl --user status bookmarks` |

Environment: `BOOKMARKS_PORT`, `BOOKMARKS_HOST`, `BOOKMARKS_DB`, `BOOKMARKS_SEED=0`
to skip the test account, and `BOOKMARKS_COMMIT` / `BOOKMARKS_DEPLOYED_AT` for a
pipeline to stamp the build shown next to the sync light.
