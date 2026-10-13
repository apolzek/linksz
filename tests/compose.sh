#!/usr/bin/env bash
# Tests the compose stack: nginx serving the PWA and proxying /api to the api.
#
# What it checks is what breaks when the two-container split is wrong:
#   * the app shell and the PWA files arriving through nginx
#   * the manifest content-type, wrong here and the browser never offers to install
#   * /api/ reaching the backend, on the same origin the session token needs
#   * the api reachable only through web, never published on its own
#   * the vault landing in the mounted directory on the host
#   * the data surviving a restart of the api
#
# The checks run from a container on the compose network instead of hitting the
# published port: it behaves the same on local Docker, Docker in a VM and CI.
#
# Usage:  bash tests/compose.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROJECT="bookmarks-test-$$"
COMPOSE=(docker compose -p "$PROJECT")
# A second stack, for the fresh clone case at the end of this file.
FRESH_PROJECT="bookmarks-fresh-$$"
FRESH_COMPOSE=(docker compose -p "$FRESH_PROJECT")
FRESH_PARENT=""
FAILS=0

# A throwaway vault. Without this the test would mount whatever
# BOOKMARKS_VAULT_DIR points at in .env, which is the real one, and create
# its test vaults in it.
VAULT=$(mktemp -d)
export BOOKMARKS_VAULT_DIR="$VAULT"
export BOOKMARKS_UID="$(id -u)"
export BOOKMARKS_GID="$(id -g)"
export BOOKMARKS_ALLOWED_ORIGINS=""


ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }

cleanup() {
  info "tearing down the test stack"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  "${FRESH_COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$VAULT"
  # That second vault is owned by whoever the entrypoint picked inside the
  # container, so it goes the same way it arrived: from a container.
  if [[ -n "$FRESH_PARENT" ]]; then
    docker run --rm -v "$FRESH_PARENT:/parent" alpine rm -rf /parent/vault >/dev/null 2>&1 || true
    rm -rf "$FRESH_PARENT"
  fi
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "docker unavailable, skipping the compose test" >&2
  exit 0
fi

info "starting the stack (the first build can take a while)"
# An ephemeral published port: the test talks to the stack from inside the
# docker network, so a fixed one here would only collide with whatever the
# machine is already running.
BOOKMARKS_WEB_PORT=0 "${COMPOSE[@]}" up -d --build >/dev/null 2>&1

# web waits on the api being healthy, so waiting on web waits on both.
for _ in $(seq 60); do
  status=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep '^web' || true)
  [[ "$status" == *healthy* ]] && break
  sleep 1
done
[[ "$status" == *healthy* ]] && ok "api and web healthy" || bad "web never became healthy: $status"

NET=$("${COMPOSE[@]}" ps -q web | xargs -r docker inspect --format \
  '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
[[ -n "$NET" ]] && ok "stack up on $NET" || { bad "web did not start"; exit 1; }

# The api declares no ports: of the two containers, only web is a way in.
published=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Ports}}' | grep '^api' | grep -c -- '->' || true)
[[ "$published" -eq 0 ]] && ok "api not published, only reachable through web" \
  || bad "api is publishing a host port"

# The vault is a file on the host, not something locked inside the container.
[[ -f "$VAULT/bookmarks.db" ]] && ok "vault created in the mounted directory" \
  || bad "no bookmarks.db in $VAULT"
[[ -w "$VAULT/bookmarks.db" ]] && ok "vault writable by the user who owns it" \
  || bad "vault not writable on the host: check BOOKMARKS_UID"
[[ "$(stat -c %u "$VAULT/bookmarks.db")" == "$(id -u)" ]] \
  && ok "the server dropped to the uid that owns the vault" \
  || bad "vault owned by $(stat -c %U "$VAULT/bookmarks.db"), not by $(id -un)"

# CORS is closed unless someone asks for it, and the api above got no allowlist.
cors=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c \
  "curl -s -o /dev/null -D - -H 'Origin: https://evil.example' http://web/api/health" 2>/dev/null \
  | grep -ic 'access-control-allow-origin' || true)
[[ "$cors" -eq 0 ]] && ok "no CORS header for an origin nobody allowed" \
  || bad "the api answered a cross-origin request it was not configured for"

info "testing the app through nginx"
output=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c "
C='curl -s'

# 1. everything the browser needs to install the app, served by nginx
for p in / /index.html /style.css /app.js /search.js /js/store.js /js/organize.js /manifest.webmanifest /sw.js /icon-512.png; do
  st=\$(\$C -o /dev/null -w '%{http_code}' http://web\$p)
  [ \"\$st\" = 200 ] && echo \"PASS serves \$p\" || echo \"FAIL serves \$p (\$st)\"
done

# 2. the manifest type: wrong here and the browser never offers to install
ct=\$(\$C -o /dev/null -w '%{content_type}' http://web/manifest.webmanifest)
case \"\$ct\" in
  application/manifest+json*) echo 'PASS manifest content-type' ;;
  *) echo \"FAIL manifest content-type (\$ct)\" ;;
esac

# 3. the build inputs are not part of the site
st=\$(\$C -o /dev/null -w '%{http_code}' http://web/nginx.conf)
[ \"\$st\" = 404 ] && echo 'PASS nginx.conf not served' || echo \"FAIL nginx.conf served (\$st)\"

# 4. /api/ reaches the backend, on the same origin the session token needs
\$C http://web/api/health | grep -q '\"ok\":true' \
  && echo 'PASS api through nginx' || echo 'FAIL api through nginx'

# 5. the full API, advanced search included, in a vault of its own. The key
# is kept so the persistence check below can open the same vault again. No
# backticks in here, the whole block is a double-quoted string for sh -c.
VAULT_JSON=\$(\$C -X POST http://web/api/auth/vault -H 'content-type: application/json' -d '{\"name\":\"composetest\"}')
TOKEN=\$(echo \"\$VAULT_JSON\" | sed -n 's/.*\"token\":\"\([^\"]*\)\".*/\1/p')
KEY=\$(echo \"\$VAULT_JSON\" | sed -n 's/.*\"key\":\"\([^\"]*\)\".*/\1/p')
[ -n \"\$TOKEN\" ] && [ -n \"\$KEY\" ] && echo 'PASS a vault and its key over the API' || echo 'FAIL a vault and its key over the API'
echo \"KEY \$KEY\"

A=\"authorization: Bearer \$TOKEN\"
\$C -o /dev/null -X POST http://web/api/bookmarks -H 'content-type: application/json' \
  -H \"\$A\" -d '{\"url\":\"https://nginx.org\",\"title\":\"Nginx\",\"tags\":\"http,proxy\"}'
\$C -o /dev/null -X POST http://web/api/bookmarks -H 'content-type: application/json' \
  -H \"\$A\" -d '{\"url\":\"https://go.dev\",\"title\":\"Go\",\"tags\":\"go\"}'

\$C 'http://web/api/bookmarks?q=%23http' -H \"\$A\" | grep -q '\"title\":\"Nginx\"' \
  && echo 'PASS tag search through nginx' || echo 'FAIL tag search through nginx'
\$C 'http://web/api/bookmarks?q=-%23http' -H \"\$A\" | grep -q '\"title\":\"Go\"' \
  && echo 'PASS negated search through nginx' || echo 'FAIL negated search through nginx'
" 2>/dev/null)

while IFS= read -r line; do
  case "$line" in
    KEY*) KEY="${line#KEY }" ;;
    PASS*) ok "${line#PASS }" ;;
    FAIL*) bad "${line#FAIL }" ;;
  esac
done <<< "$output"

info "restarting the api to check persistence in the volume"
"${COMPOSE[@]}" restart api >/dev/null 2>&1
sleep 4

persist=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c "
TOKEN=\$(curl -s -X POST http://web/api/auth/key \
  -H 'content-type: application/json' -d '{\"key\":\"$KEY\"}' \
  | sed -n 's/.*\"token\":\"\([^\"]*\)\".*/\1/p')
curl -s http://web/api/bookmarks -H \"authorization: Bearer \$TOKEN\"
" 2>/dev/null)

echo "$persist" | grep -q '"title":"Nginx"' \
  && ok "data survives the restart" \
  || bad "data lost after the restart"

# And the same rows are readable straight off the host file, no container needed.
node -e "
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(process.argv[1], { readOnly: true });
  const n = db.prepare(\"SELECT count(*) c FROM bookmarks WHERE title = 'Nginx'\").get().c;
  process.exit(n === 1 ? 0 : 1);
" "$VAULT/bookmarks.db" 2>/dev/null \
  && ok "the host file is the vault, readable without docker" \
  || bad "the host file does not carry what the API wrote"

# The fresh clone: BOOKMARKS_VAULT_DIR points at a directory that does not exist
# yet, so the docker daemon creates the bind mount and it lands owned by root.
# Nothing in the environment says which uid to use either. The stack has to come
# up anyway; this is the case that used to die on `unable to open database file`.
info "starting a second stack on a vault directory that does not exist"
FRESH_PARENT=$(mktemp -d)
FRESH_VAULT="$FRESH_PARENT/vault"
(
  unset BOOKMARKS_UID BOOKMARKS_GID
  export BOOKMARKS_VAULT_DIR="$FRESH_VAULT"
  BOOKMARKS_WEB_PORT=0 "${FRESH_COMPOSE[@]}" up -d --build >/dev/null 2>&1
)
for _ in $(seq 60); do
  fresh_status=$("${FRESH_COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep '^api' || true)
  [[ "$fresh_status" == *healthy* ]] && break
  sleep 1
done
[[ "$fresh_status" == *healthy* ]] \
  && ok "api healthy on a vault directory docker had to create" \
  || bad "api never became healthy on a fresh vault: $fresh_status"
[[ -f "$FRESH_VAULT/bookmarks.db" ]] \
  && ok "vault created in the directory docker made" \
  || bad "no bookmarks.db in a vault directory created by docker"

echo
if [[ $FAILS -eq 0 ]]; then
  printf '\033[32m✔ compose ok\033[0m\n'
else
  printf '\033[31m✖ %d compose check(s) failed\033[0m\n' "$FAILS"
  exit 1
fi
