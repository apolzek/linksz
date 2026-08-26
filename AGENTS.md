# Working on this repository

## Language

Everything written into the repository is in English: code, identifiers,
comments, docstrings, commit messages, documentation, test names and the
strings the user reads in the UI. Conversation with the maintainer happens in
Portuguese; the repository does not.

Older commits and a few test names are still in Portuguese. Translate them when
you touch that code, and do not add new ones.

## Shape

```
api/        backend: HTTP, SQLite, import/export. Node built-ins only, no deps
web/        the PWA the backend serves on the same port
desktop/    the GTK/Tk bar and its installers
tests/      one suite for all three: bash tests/run.sh
```

Two rules the code depends on:

* **No dependencies.** The backend runs on Node built-ins (`node:sqlite`
  included), the bar on the Python standard library. Adding a package is a
  decision, not a detail: ask first.
* **The search engine exists twice.** `web/search.js` and
  `desktop/bookmarks_search.py` must return the same results for the same
  query; a parity test compares them on random vaults. Change one, change the
  other, in the same commit.

## The desktop bar reads

The bar searches, opens and copies. Creating, editing and deleting live in the
web UI, and the account it connects to comes from `~/.config/bookmarks/config.json`:
no login dialog, no way to register. The only thing it writes is the open
counter that feeds the ranking.

## Before saying it works

Run `bash tests/run.sh`. It covers the API, both search engines, the YAML
round trip and the bar. `bash tests/run.sh --compose` adds the Docker stack
with TLS, which is slower and needs Docker running.

Validate against the real thing when the change is user-facing: hit the running
server with `curl`, or drive the page. A change nobody exercised is a change
that is not done.
