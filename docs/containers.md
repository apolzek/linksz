# Running in containers

Three images, each versioned by the last commit that touched it:

    nochaos/bookmarks-api      the backend
    nochaos/bookmarks-web      nginx: the PWA, and /api proxied to the api
    nochaos/bookmarks-proxy    caddy: TLS, so the PWA installs anywhere

    docker compose up -d --build

From a clone that builds them, or from the published ones with no clone at all:

    services:
      api:
        image: nochaos/bookmarks-api:latest
        environment:
          BOOKMARKS_HOST: 0.0.0.0
          BOOKMARKS_DB: /data/bookmarks.db
        volumes: [bookmarks-data:/data]
      web:
        image: nochaos/bookmarks-web:latest
        depends_on: { api: { condition: service_healthy } }
      proxy:
        image: nochaos/bookmarks-proxy:latest
        depends_on: { web: { condition: service_healthy } }
        environment:
          BOOKMARKS_SITE: 192.168.0.10
        ports: ["80:80", "443:443"]
        volumes: [caddy-data:/data, caddy-config:/config]

## The PWA does work here

It is worth stating plainly, because the shape of the stack suggests otherwise.
A PWA installs, and a service worker registers, only in a **secure context**,
which means https or localhost. Measured on this stack, same build, same
browser:

    http://localhost:8080          secure context: yes    service worker: registers
    http://192.168.0.10:8080       secure context: no     navigator.serviceWorker: absent

So there are two ways to get the app, and both work:

* **On this machine**, http://localhost:8080 is already a secure context. The
  proxy adds nothing: `docker compose up -d api web`.
* **From a phone, or any other machine**, you need TLS, which is the proxy's
  entire reason to exist.

## The phone

    1. find this machine's IP:  ip route get 1 | awk '{print $7; exit}'
    2. BOOKMARKS_SITE=192.168.0.10 docker compose up -d
    3. on the phone, open http://192.168.0.10/root.crt and install the certificate
    4. open https://192.168.0.10 and use "Add to home screen"

Step 3 is not optional. Caddy issues the certificate from a CA it generates on
first boot, and a phone that has not been told to trust that CA refuses the
HTTPS. On iOS, installing the profile is two steps: Settings > Profile
Downloaded, then Settings > General > About > Certificate Trust Settings.

The CA lives in the `caddy-data` volume. Deleting that volume issues a new CA
and every device has to trust the new one.

With a real domain, or a tunnel that already terminates TLS (Tailscale,
Cloudflare), drop the proxy and point your existing TLS at `web:80`.

## Environment

    BOOKMARKS_HOST            interface the api binds to, 0.0.0.0 in a container
    BOOKMARKS_PORT            api port, default 8787
    BOOKMARKS_DB              path to the vault, default /data/bookmarks.db
    BOOKMARKS_SEED=0          do not create the test account
    BOOKMARKS_SEED_PASSWORD   password for it, default teste123
    BOOKMARKS_SITE            hostname or IP the certificate is issued for
    BOOKMARKS_COMMIT          build stamp shown next to the sync light
    BOOKMARKS_DEPLOYED_AT     the other half of that stamp

The stack seeds a `teste` / `teste123` account on every boot. On a network
anyone else can reach, set `BOOKMARKS_SEED=0` or change the password before
leaving it running.

## Data

The vault is a SQLite file in the `bookmarks-data` volume. To back it up
consistently, without stopping the container:

    docker compose exec api node -e "
      const { DatabaseSync } = require('node:sqlite');
      new DatabaseSync(process.env.BOOKMARKS_DB, { readOnly: true })
        .exec(\"VACUUM INTO '/data/backup.db'\")"
    docker compose cp api:/data/backup.db ./backup.db

Or export YAML from the web UI, which is the portable form and reads back into
any vault.

## Architecture

The published images are `linux/amd64`. On Apple Silicon or a Raspberry Pi they
run under emulation, when they run at all. Build them locally for your platform
until the pipeline publishes arm64:

    docker compose build
