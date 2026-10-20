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
web/        the PWA, and the nginx image that serves it
docs/       how to run it
tests/      one suite for all of it: bash tests/run.sh
omarchy/    adds it to the Omarchy app menu: bash omarchy/install.sh
```

It runs in containers, and only there: `docker compose up -d --build`, then
http://localhost:8080. Two services, api and web. nginx serves the PWA and
proxies `/api` to the backend, so the browser sees one origin.

Three rules the code depends on:

* **No dependencies.** The backend runs on Node built-ins (`node:sqlite`
  included) and the frontend on nothing at all. Adding a package is a decision,
  not a detail: ask first. The same goes for the tests: they are `node --test`
  and bash, with no framework to install.
* **`web/search.js` is shared.** The backend imports it, which is why the api
  image is built from the repository root and copies that one file out of
  `web/`. It runs in both places and must behave the same in both.
* **A PWA needs a secure context.** It installs, and its service worker
  registers, only over https or on localhost. That is why localhost is the
  supported way in, and why a change that moves the app off localhost has to
  bring TLS with it.
* **The vault is a file on the host.** `BOOKMARKS_VAULT_DIR` is bind-mounted at
  `/data`, so the api runs as the uid that owns it rather than the image's own
  user. Anything that starts the stack from this repository inherits the real
  `.env`, which is why `tests/compose.sh` exports a throwaway
  `BOOKMARKS_VAULT_DIR` before it does: a test that creates vaults in
  somebody's actual database is a bug, not a test.
* **CORS is closed.** The API sets no `access-control-allow-origin` unless
  `BOOKMARKS_ALLOWED_ORIGINS` names the origin. The app is same-origin behind
  nginx and needs none, so anything that wants the header should say why.

## Before saying it works

Run `bash tests/run.sh`. It covers the API, the search engine, the YAML round
trip, import/export, saving from the address bar and the theme's tokens. Two
extras are opt in, because each needs something the
machine may not have and each skips itself rather than failing when it is
missing:

    bash tests/run.sh --web        the app in headless Chrome
    bash tests/run.sh --compose    the two containers behind nginx
    bash tests/run.sh --all        both

`--web` starts the backend on a throwaway vault, opens the page in the browser
already installed and drives it over the DevTools protocol. It is where the
keyboard, the modals and the two import flows are checked, none of which the
node suite can see. Two things about it are easy to get wrong twice, so they are
written down in `tests/web.sh`: `--headless=new` accepts input events and
delivers none of them, and navigating with `Page.navigate` kills input for the
rest of the session.

Validate against the real thing when the change is user-facing: hit the running
server with `curl`, or drive the page in a browser. A change nobody exercised is
a change that is not done.

Test vaults belong in a throwaway database. Pointing them at the running
server leaves users and bookmarks behind in the real vault.
