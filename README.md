# Bookmarks

Self-hosted bookmark manager with instant substring search, served as a PWA that
installs and works offline. No dependencies, no accounts anywhere but your own
machine.

## Running it

Docker, two containers:

    git clone git@github.com:nochaosio/bookmarks.nochaos.io.git
    cd bookmarks.nochaos.io
    docker compose up -d --build

Open http://localhost:8080 and sign in with the test account `teste` /
`teste123`, or register your own.

The vault is a plain SQLite file in a directory on your machine, mounted into
the api container. By default that is `./data`; to point it at one you already
have, copy `.env.example` to `.env` and set `BOOKMARKS_VAULT_DIR` along with
the uid that owns it. `docs/containers.md` has the rest: the published images,
the environment, backups.

## It is an app, not a page

A PWA installs, and a service worker registers, only in a secure context:
https, or localhost. Measured on this stack, same build, same browser:

    http://localhost:8080          secure context: yes    service worker: registers
    http://192.168.0.10:8080       secure context: no     navigator.serviceWorker: absent

On the machine running it, localhost is trusted by definition, so you get the
install prompt and the shell works offline. Reaching it from a phone or another
machine needs TLS, and this stack does not ship one: put a tunnel that already
terminates TLS (Tailscale, Cloudflare) or a reverse proxy you already run in
front of `web:80`.

## The web UI

Up and down navigate, Enter opens, Ctrl+Enter opens in a new tab, F2 edits the
selected link, Ctrl+Del deletes it, `n` creates, `b` toggles the panel, `/`
focuses the search, Ctrl+C clears it. Type `help` for the rest.

Edit and delete are not letters because the caret lives in the search box: it
takes focus on boot and after most actions, so a letter there is text, not a
command. With the caret somewhere else, `e` and `Del` do the same two.

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

The same syntax in the web UI and the API. Everything is substring, case and
accent insensitive, and terms combine with AND.

    kuber              title, URL, tags, category, folder or description
    #devops            tags only
    @work              category only
    /dev/infra         folder only
    title:grafana      that field only, also url:, description:, cat:, folder:
    "hacker news"      literal phrase
    -grafana           excludes matches

## Import and export

Export is YAML, browser HTML or JSON. Import comes in two flows, because the
two files are not the same thing and pretending otherwise loses data:

    From this app     YAML or JSON exported here. Ids, folders, categories,
                      tags, descriptions and counters all survive.
    From a browser    two files work: the HTML Chrome, Firefox, Edge and
                      Safari export, and the browser's own `Bookmarks` file
                      from its profile directory, which on Linux is
                      ~/.config/google-chrome/Default/Bookmarks (no extension,
                      so pick "All files" if the dialog hides it). Either way
                      you get the folder tree, the title, the URL and the date.
                      No categories: the format has none. Tags only where the
                      browser wrote them. No ids, so an existing bookmark is
                      matched by its URL.

Pick the flow before the file. A file offered to the wrong one is refused with
a pointer to the other, never read on a best effort, because a browser file
read as a vault file looks like a vault that lost its categories, and importing
that with "Use the file" would erase them for real.

The browser flow can drop the whole imported tree under a folder of your own,
and it is not allowed to replace the vault: it knows nothing about the
bookmarks it would be deleting. It also may add but never take away. The
default, "Keep what is here", only creates what is missing; and even when told
to overwrite, a browser file cannot blank a category, a tag or a note on a
bookmark that already has one, because the format has no way to say those and
silence is not an instruction.

The YAML groups entries by folder, so the file is the tree written down:

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

## Layout

    api/        backend: HTTP, SQLite, import/export. Node built-ins only
    web/        the PWA, and the nginx image that serves it
    docs/       how to run it
    tests/      one suite for all of it: bash tests/run.sh
    data/       the vault, unless .env points somewhere else (not committed)

## Day to day

    mise run up        the stack on http://localhost:8080
    mise run logs      follow both containers
    mise run down      stop it
    mise run test      the suite
    mise run test-all  the suite plus the browser and the docker stack

`mise` only pins Node 24 for the test suite; the app itself needs nothing but
Docker. Without mise, the same commands are `docker compose up -d --build` and
`bash tests/run.sh`.

Environment variables live in `.env` and are documented in
`docs/containers.md`. The short version: `BOOKMARKS_VAULT_DIR` is where the
vault file lives, `BOOKMARKS_WEB_PORT` moves the published port,
`BOOKMARKS_SEED=0` skips the test account.

The API answers no cross-origin request unless `BOOKMARKS_ALLOWED_ORIGINS`
names the origin. The app never needs it, being same-origin behind nginx; it is
there for something else that wants to drive the API from a page.

## Images

Each image is versioned by the last commit that touched it, so a frontend
release leaves the backend on the tag it had:

    nochaos/bookmarks-api      the backend
    nochaos/bookmarks-web      nginx: the PWA, and /api proxied to the api

nginx serves the PWA and proxies `/api`, so the browser sees one origin, which
is what the session token and the service worker want. The api publishes no
port of its own.

## CI

`.github/workflows/docker.yml` runs the suite, builds both images, scans each
with trivy and logs into both registries so a stale credential surfaces on an
ordinary push. Publishing is opt in: dispatch the workflow with `push` checked.
