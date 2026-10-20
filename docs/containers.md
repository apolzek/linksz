# Running it

Two images, each versioned by the last commit that touched it:

    nochaos/bookmarks-api      the backend
    nochaos/bookmarks-web      nginx: the PWA, and /api proxied to the api

From a clone that builds them:

    git clone git@github.com:nochaosio/bookmarks.nochaos.io.git
    cd bookmarks.nochaos.io
    docker compose up -d --build

Nothing to configure first: `.env` is optional (see The vault below) and the
vault directory ships with the clone, so the command above is the whole install.

Then open http://localhost:8080 and choose **Create one** to make a vault. Its
access key is shown once; keep it, it is the only way in.

From the published images, with no clone at all:

    services:
      api:
        image: nochaos/bookmarks-api:latest
        environment:
          BOOKMARKS_HOST: 0.0.0.0
          BOOKMARKS_DB: /data/bookmarks.db
        # Create ./data yourself before the first boot. A directory the
        # docker daemon has to invent lands owned by root, and then the vault
        # is root's too instead of yours.
        volumes: ["./data:/data"]
      web:
        image: nochaos/bookmarks-web:latest
        depends_on: { api: { condition: service_healthy } }
        ports: ["8080:80"]

## The vault

`BOOKMARKS_VAULT_DIR` is a directory on the host, mounted at `/data` in the api
container, and `bookmarks.db` inside it is the whole vault. Without a `.env` it
is `./data` next to the compose file; `.env.example` is the shape of the file
that moves it:

    BOOKMARKS_VAULT_DIR=/home/you/.local/share/bookmarks

A directory and not the file itself, because SQLite writes `bookmarks.db-wal`
and `bookmarks.db-shm` next to it, and a single-file mount would strand those
inside the container.

The uid matters, and it is handled for you. The image has its own unprivileged
user, which owns nothing on your disk, so what the api runs as is decided at
boot: the container's entrypoint reads who owns the mounted directory and drops
to that user, which keeps the vault readable and writable from both sides.
`BOOKMARKS_UID` and `BOOKMARKS_GID` override it, and are only worth setting when
you want a uid other than the directory's owner.

One case is worth knowing: point `BOOKMARKS_VAULT_DIR` at a directory that does
not exist and the docker daemon creates it as root. The stack still comes up,
with the vault owned by the image's own user, and you will need `sudo` to touch
it from the host. Creating the directory first (`mkdir -p`) is all it takes to
keep it yours.

Copying a vault in is copying a file:

    docker compose down
    cp somewhere/bookmarks.db "$BOOKMARKS_VAULT_DIR/bookmarks.db"
    docker compose up -d

Copy the `-wal` file with it, or checkpoint it first, or the last writes are
still in it and not in the vault:

    node -e "new (require('node:sqlite').DatabaseSync)('bookmarks.db').prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()"

## Why two containers

nginx serves the PWA and proxies `/api` to the backend, so the browser talks to
one origin: same-origin is what the session token and the service worker want,
and it is why the api publishes no port of its own. The api image carries the
backend and `web/search.js`, the one file both sides share, not the whole
frontend.

## The PWA installs here

A PWA installs, and a service worker registers, only in a **secure context**,
which means https or localhost. Measured on this stack, same build, same
browser:

    http://localhost:8080          secure context: yes    service worker: registers
    http://192.168.0.10:8080       secure context: no     navigator.serviceWorker: absent

So on the machine running it, http://localhost:8080 is an app: installable,
with the shell cached and working offline. The data still comes from the API,
because a bookmark changes and must not be served stale.

Reaching it from a phone, or from another machine, means putting TLS in front.
This stack deliberately does not ship one: use a tunnel that already terminates
TLS (Tailscale, Cloudflare) or a reverse proxy you already run, and point it at
`web:80`. Over plain HTTP on a LAN address the browser does not even expose
`navigator.serviceWorker`, so there you get a website, not an app.

## Environment

    BOOKMARKS_VAULT_DIR       host directory holding bookmarks.db, default ./data
    BOOKMARKS_UID             uid the api runs as, default: the owner of that directory
    BOOKMARKS_GID             gid to go with it
    BOOKMARKS_HOST            interface the api binds to, 0.0.0.0 in a container
    BOOKMARKS_PORT            port the api listens on inside its container, default 8787
    BOOKMARKS_WEB_PORT        host port nginx is published on, default 8080
    BOOKMARKS_DB              path to the vault inside the container, default /data/bookmarks.db
    BOOKMARKS_ALLOWED_ORIGINS origins allowed to call the API from a browser, empty by default
    BOOKMARKS_DEV_KEY         an access key; a vault that opens with it is made on boot.
                              For development and tests only: unset by default
    BOOKMARKS_COMMIT          build stamp shown at the bottom of Settings
    BOOKMARKS_DEPLOYED_AT     the other half of that stamp

`BOOKMARKS_PORT` and `BOOKMARKS_WEB_PORT` are different things on purpose: the
first is internal to the api container, the second is the only port that
reaches your machine.

## Access keys

There are no users and no passwords. Each vault has one access key, 160 random
bits in Crockford base32 (`XXXX-XXXX-…`, eight groups), and the server keeps
only its SHA-256. Typing the key exchanges it for a session token, which is
what a device holds.

Anyone who can reach the stack can create a vault, as anyone could register
before. Opening someone else's vault takes their key.

A vault from before the keys keeps its bookmarks and gets a key on the first
boot with this version, printed once:

    docker compose logs api | grep 'access key'

The host can always issue a new key, which also signs out every device using
the old one:

    docker compose exec api node api/keys.js              list the vaults
    docker compose exec api node api/keys.js issue <id>   a new key for that vault

## CORS

The API answers no cross-origin request unless you name the origin. The app
never needs it: nginx serves the PWA and proxies `/api`, so the browser only
ever talks to one origin. Something else driving the API from a page is what
the variable is for, comma separated:

    BOOKMARKS_ALLOWED_ORIGINS=https://notes.example,https://dash.example

`*` answers everyone. A refused origin still gets a normal response on the
wire, which is why `curl` and scripts are unaffected: what a browser withholds
from the page is the body of a response with no matching header.

## Backups

The vault is a SQLite file in `BOOKMARKS_VAULT_DIR`, so a copy is a copy. To
take one consistently, without stopping the container:

    docker compose exec api node -e "
      const { DatabaseSync } = require('node:sqlite');
      new DatabaseSync(process.env.BOOKMARKS_DB, { readOnly: true })
        .exec(\"VACUUM INTO '/data/backup.db'\")"

It lands in `BOOKMARKS_VAULT_DIR` next to the vault, because that directory is
the mount. Copying `bookmarks.db` while the container runs is not a backup: the
`-wal` beside it holds writes the file does not have yet.

Or export YAML from the web UI, which is the portable form and reads back into
any vault.

## Architecture

The published images are `linux/amd64`. On Apple Silicon or a Raspberry Pi they
run under emulation, when they run at all. Build them locally for your platform
until the pipeline publishes arm64:

    docker compose up -d --build

## Day to day

    docker compose up -d --build     start, or apply a change
    docker compose logs -f           follow both containers
    docker compose ps                what is up and healthy
    docker compose down              stop; the vault is a file on disk and stays

A change under `web/` needs `docker compose up -d --build web`: the PWA is
baked into the image, not mounted.

## On Omarchy

    bash omarchy/install.sh            add Bookmarks to the app menu
    bash omarchy/install.sh --remove   take it out again

It installs a web app with `omarchy-webapp-install`, pointed at
`http://localhost:$BOOKMARKS_WEB_PORT` and using the app's own icon, so it
opens in its own window from the app menu (Super+Alt+Space). The stack still
has to be running.
