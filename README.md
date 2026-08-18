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

`↑` `↓` navigate, `Enter` open, `e` edit, `Del` delete, `n` new, `b` panel, `/` focus search.

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
```
