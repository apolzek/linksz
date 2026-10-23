# Linksz

Self-hosted bookmark manager with instant substring search, served as a PWA that
installs and works offline. No dependencies, no accounts, no passwords: a vault
opens with its access key.

## Running it

Docker, two containers:

    git clone https://github.com/apolzek/linksz.git
    cd linksz
    docker compose up -d --build

Open http://localhost:8080 and choose **Create one**. The app makes a vault and
shows its access key, once: keep it in a password manager, because it is the
only way in and only its hash is stored. On another device, paste the same key.

A vault from before the keys keeps every bookmark and gets a key on its first
boot with this version, printed once in `docker compose logs api`. A lost key
is never read back, but the host can always issue a new one:

    docker compose exec api node api/keys.js              list the vaults
    docker compose exec api node api/keys.js issue 1      a new key for vault 1

Settings has **Generate a new key** too: the old one stops working at once, and
every other device signed in with it is signed out.

The vault is a plain SQLite file in a directory on your machine, mounted into
the api container. By default that is `./data`; to point it at one you already
have, copy `.env.example` to `.env` and set `LINKSZ_VAULT_DIR` along with
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

Six pages, in the sidebar (and under the thumb on a phone):

    All links         the search box and the list
    Organize          two folders side by side, for moving links between them
    Activity          opens per day, the most opened links, the recent ones
    Audit log         every change to a link, and every click, with when
    Import & export   backups and bringing links in
    Settings          theme, the vault's name, saving from anywhere, the key,
                      signing out

**All links.** Typing searches the whole vault as you type. The folder tree in
the sidebar narrows the list to one folder and everything below it. Up and down
move, Enter opens, `/` or Ctrl+K focuses the search, Esc clears the selection
and then the search. With the caret out of a text field: `n` new, `e` or F2
edit, `m` move, `x` select, Del delete; in the search box, Alt plus the same
letter. Ctrl+click and Shift+click select like a file manager (on a phone,
press and hold), Ctrl+A selects everything listed, and the bar that appears
moves or deletes the lot. Deleting and moving can be undone from the toast.
The switch above the list, or `g`, shows the same results by folder: a heading
per folder with its count, which folds its links away, and Open on the heading
narrows the list to it. Search, selection and the keys work the same way in
both; what is folded away is not selected.

**Audit log.** Two lists, newest first, each with the date and time to the
second. *Link changes* is every link added, edited, moved, deleted or
restored, whichever way it happened: the form, a move, an import, a folder
renamed, another device's sync. An edit shows each field before and after, a
move where from and where to, and each row says what it came through (app,
import, folder). The server works these out by comparing a link before and
after each write, so no route can forget to log, and an open counted logs
nothing. *Clicks* is everything clicked in the app, on every page: what it
said, which element, where. Only clicks, never what was typed. Clicks are
sent in batches and kept for 90 days; link changes are kept.

**Organize.** One folder on each side. Click links to select them (Shift for a
run, the box at the top for all), then the arrow between the panes, or the
arrow keys, sends them across. Subfolders are listed first in each pane; click
one to go in, or Ctrl+click (Cmd on a Mac) to select it instead, with Shift for
a run. Selected folders move with the selected links. Links dragged onto a
subfolder, a breadcrumb, the other pane or a folder in the sidebar are filed
there, and a folder dragged onto another moves inside it, along with every
other folder selected beside it. Ctrl+A selects every folder and link the
pane lists, and Del, or the bin that appears next to the count, deletes what is
selected, folders with everything in them, after asking once. Each pane can
make, rename and delete the folder it shows, and add a link to it: the plus at
its top, or `n` for the pane in focus. Ctrl+V with a link on the clipboard
files it in the folder in focus at once, and a moment later gives it a title:
the one the page gives itself (the server reads it, as itself, never posing as
another site's crawler, and never from an address on a private network), or,
when the page answers with a challenge or a shell, the words in its address.
Several lines of links file them all, and one already in that folder is not
filed twice. The
pencil on a link, shown on hover, edits it; so do `e` and F2 with one link
selected.

**Saving from anywhere.** Put the app's address in front of any link; see
[Saving a link from anywhere](#saving-a-link-from-anywhere).

**Speed.** The vault is kept in the browser (IndexedDB) and searched there, so
a keystroke never waits on the network and a reload paints from that copy at
once, then asks the server only for what changed. Writes show up on screen
before the server answers and are put back if it refuses. Another tab sees a
change at once; another device within five seconds.

Every open counts: the most opened links climb the results.

## Saving a link from anywhere

Put the app's address in front of a link and open it, the way people put
something in front of a YouTube address to download a video:

    https://www.youtube.com/watch?v=_Hkdzzx15PI
    http://localhost:8080/https://www.youtube.com/watch?v=_Hkdzzx15PI

The `https://` can be left out, and the query and the hash are kept as part
of the link:

    http://localhost:8080/www.youtube.com/watch?v=_Hkdzzx15PI
    http://localhost:8080/github.com/basecamp/omarchy
    http://localhost:8080/news.ycombinator.com

What happens next:

* **Signed in on this device:** the link is saved at once to **Temporary**, the
  folder for what is not sorted yet, and the list opens on it. The toast has an
  Undo. To file the link, move it out of Temporary.
* **Not signed in:** the screen says *Save this link*, shows the site and where
  it will go, and asks for the access key only. Type or paste it (**Paste**
  reads the clipboard, and a whole key goes in by itself) and the link is saved.
* **Already in the vault:** nothing is added, and the list opens on the folder
  that has it. A trailing slash does not make a second copy.

The address bar goes back to `/` afterwards, so a reload saves nothing. The
title is the site's name (`youtube.com`); rename it later if you want. Saving
needs no confirmation, so a page that sends you to such an address can add a
link to your vault. That is the whole cost, and the Undo takes it back.

On the server it is your domain that comes first, e.g.
`https://linksz.example.com/https://...`; nothing in the code names a host.

**Bookmarklet.** Settings, *Save from anywhere*, has a **Save to Linksz**
button. Drag it to the browser's bookmarks bar; clicking it on any page opens
that page's address behind the prefix in a new tab, and the page itself stays
where it was.

**Phones.** On Android, the installed app is in the share sheet (the manifest's
`share_target`): share a page to Linksz and the form opens filled in. Safari
on iOS has no share target; the address prefix works there as anywhere else.
Either way the phone needs the app over https, see
[It is an app, not a page](#it-is-an-app-not-a-page).

## On the desktop (Omarchy)

The same app, in a window of its own and in the app launcher. Omarchy turns any
address into a desktop app with a launcher entry:

    omarchy webapp install "Linksz" "http://localhost:8080" "$PWD/web/icon-512.png"

It opens in Chromium's app mode: no tabs and no address bar, and the same code
the browser runs, so a `docker compose up -d --build` is all an update takes.
To take it out of the launcher:

    omarchy webapp remove Linksz

The window is only as up as the stack. The containers restart with Docker
(`restart: unless-stopped`), but Arch starts Docker on first use, not at boot,
so after a reboot the app would say the server is not answering. To have it up
from boot:

    sudo systemctl enable docker

Elsewhere: Chrome and Edge install it from the icon in the address bar, on any
system, with the same result.

## The look

The theme is [omarchy.org](https://omarchy.org)'s. Dark is Tokyo Night, the
site's default; light is Catppuccin Latte, one of Omarchy's light themes.
Settings picks System, Light or Dark. Corners are square, a 1px ring stands in
for shadows, and everything is set in JetBrains Mono, which ships with the app
(`web/fonts/`, under the SIL Open Font License) so it looks the same offline
and on a phone that does not have it.

The colours are tokens at the top of `web/style.css`. The dark palette is
written twice there, once for the system's choice and once for the person's;
`tests/theme.test.js` fails if the two drift apart or a colour is used that
neither defines.

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

    From this app     YAML or JSON exported here. Ids, the folder tree (empty
                      folders too), categories, tags, descriptions and
                      counters all survive.
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

## Tests

    bash tests/run.sh              api, search, YAML, import/export, the address
                                   bar, the theme and the audit trail
    bash tests/run.sh --web        adds the app in headless Chrome
    bash tests/run.sh --compose    adds the two containers behind nginx
    bash tests/run.sh --all        both

Node built-ins and bash, nothing to install. The address bar is covered three
ways: `tests/address.test.mjs` reads links out of addresses and holds the app,
the node server and nginx to the same rule about which paths get the app; the
browser suite saves a link signed out and signed in; the compose suite asks
nginx for one. `--web` and `--compose` skip themselves on a machine without
Chrome or Docker.

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
`docs/containers.md`. The short version: `LINKSZ_VAULT_DIR` is where the
vault file lives, `LINKSZ_WEB_PORT` moves the published port,
`LINKSZ_DEV_KEY` makes one known vault for development (never on a host
others can reach).

The API answers no cross-origin request unless `LINKSZ_ALLOWED_ORIGINS`
names the origin. The app never needs it, being same-origin behind nginx; it is
there for something else that wants to drive the API from a page.

## Images

Each image is versioned by the last commit that touched it, so a frontend
release leaves the backend on the tag it had:

    ghcr.io/apolzek/linksz-api      the backend
    ghcr.io/apolzek/linksz-web      nginx: the PWA, and /api proxied to the api

nginx serves the PWA and proxies `/api`, so the browser sees one origin, which
is what the session token and the service worker want. The api publishes no
port of its own.

## CI

`.github/workflows/docker.yml` runs the suite, builds both images, scans each
with trivy and logs into both registries so a stale credential surfaces on an
ordinary push. Publishing is opt in: dispatch the workflow with `push` checked.
