# Working on this repository

## Language

Everything written into the repository is in English: code, identifiers,
comments, docstrings, commit messages, documentation, test names and the
strings the user reads in the UI. Conversation with the maintainer happens in
Portuguese; the repository does not.

The code, the tests and the docs are English throughout. Four commits from
before this rule are not, and rewriting published history is not worth it;
everything from `429a8b1` on follows it.

## Shape

```
api/        backend: HTTP, SQLite, import/export. Node built-ins only, no deps
web/        the PWA, and the nginx image that serves it in Docker
proxy/      caddy with TLS: what makes the PWA installable off localhost
desktop/    the GTK/Tk bar and its installers
docs/       one page per way of running it
tests/      one suite for all of it: bash tests/run.sh
```

Three rules the code depends on:

* **No dependencies.** The backend runs on Node built-ins (`node:sqlite`
  included), the bar on the Python standard library. Adding a package is a
  decision, not a detail: ask first.
* **The search engine exists twice.** `web/search.js` and
  `desktop/bookmarks_search.py` must return the same results for the same
  query; a parity test compares them on random vaults. Change one, change the
  other, in the same commit.
* **A PWA needs a secure context.** It installs, and its service worker
  registers, only over https or on localhost. That is the whole reason the
  docker stack ships a proxy, and the reason a change that moves the app off
  localhost has to keep TLS in the picture.

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
server with `curl`, or drive the page in a browser. A change nobody exercised is
a change that is not done, and the web UI has no automated coverage yet (#1), so
there it is the only check there is.

Test accounts belong in a throwaway database. Pointing them at the running
server leaves users and bookmarks behind in the real vault.
