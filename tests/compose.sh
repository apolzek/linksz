#!/usr/bin/env bash
# Tests the compose stack (backend + Caddy with TLS), the phone path.
#
# It checks what actually matters for the PWA to install on a phone:
#   * the root CA downloadable over HTTP (the one configuration step)
#   * HTTPS validating against that CA, without -k  => "secure context"
#   * manifest and service worker arriving through the proxy
#   * the API working and the data surviving a restart
#
# The checks run from a container on the compose network instead of hitting the
# published port: it behaves the same on local Docker, Docker in a VM and CI.
#
# Usage:  bash tests/compose.sh
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

PROJECT="bookmarks-test-$$"
SITE="localhost"
# The proxy is behind a profile: this test is precisely the phone flow, so it
# asks for it explicitly.
COMPOSE=(docker compose -p "$PROJECT" --profile tls)
FAILS=0

ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
bad()  { printf '  \033[31m✖\033[0m %s\n' "$*"; FAILS=$((FAILS + 1)); }
info() { printf '\033[1;34m›\033[0m %s\n' "$*"; }

cleanup() {
  info "tearing down the test stack"
  "${COMPOSE[@]}" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

if ! docker info >/dev/null 2>&1; then
  echo "docker unavailable, skipping the compose test" >&2
  exit 0
fi

info "starting the stack (the first build can take a while)"
BOOKMARKS_SITE="$SITE" BOOKMARKS_HTTP_PORT=0 BOOKMARKS_HTTPS_PORT=0 \
  "${COMPOSE[@]}" up -d --build >/dev/null 2>&1

# Waits for the API to become healthy (web waits on it, and the proxy on web).
for _ in $(seq 60); do
  status=$("${COMPOSE[@]}" ps --format '{{.Service}} {{.Status}}' 2>/dev/null | grep '^api' || true)
  [[ "$status" == *healthy* ]] && break
  sleep 1
done
[[ "$status" == *healthy* ]] && ok "api healthy" || bad "api never became healthy: $status"

NET=$("${COMPOSE[@]}" ps -q proxy | xargs -r docker inspect --format \
  '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')
IP=$("${COMPOSE[@]}" ps -q proxy | xargs -r docker inspect --format \
  '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
[[ -n "$IP" ]] && ok "proxy up at $IP" || { bad "proxy did not start"; exit 1; }

info "testing the phone flow from inside the network"
output=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c "
R=\"--resolve $SITE:443:$IP --resolve $SITE:80:$IP\"

# 1. downloads the root CA over HTTP (the one configuration step on the phone)
code=\$(curl -s \$R -o /tmp/ca.crt -w '%{http_code}' http://$SITE/root.crt)
grep -q 'BEGIN CERTIFICATE' /tmp/ca.crt 2>/dev/null \
  && echo 'PASS root CA served over HTTP' || echo \"FAIL root CA (http \$code)\"

C=\"curl -s \$R --cacert /tmp/ca.crt\"

# 2. trusted HTTPS: without it the service worker does not register and the PWA does not install
for p in / /manifest.webmanifest /sw.js /icon-512.png /api/health; do
  st=\$(\$C -o /dev/null -w '%{http_code}' https://$SITE\$p)
  [ \"\$st\" = 200 ] && echo \"PASS https \$p\" || echo \"FAIL https \$p (\$st)\"
done

# 3. without the CA the certificate has to be refused (proof this is real TLS)
curl -s \$R -o /dev/null https://$SITE/ 2>/dev/null \
  && echo 'FAIL certificate accepted without the CA' || echo 'PASS certificate refused without the CA'

# 4. HTTP redirects to HTTPS
st=\$(curl -s \$R -o /dev/null -w '%{http_code}' http://$SITE/)
[ \"\$st\" = 301 ] && echo 'PASS http redirects' || echo \"FAIL http redirects (\$st)\"

# 5. manifest type: wrong here and the browser never offers to install
ct=\$(\$C -o /dev/null -w '%{content_type}' https://$SITE/manifest.webmanifest)
case \"\$ct\" in
  application/manifest+json*) echo 'PASS content-type do manifest' ;;
  *) echo \"FAIL manifest content-type (\$ct)\" ;;
esac

# 6. the full API through the proxy, advanced search included.
# The account is composetest, not teste: the stack seeds a teste user on every
# boot and registering it again is a 409, not a test failure. No backticks in
# here, the whole block is a double-quoted string for sh -c.
TOKEN=\$(\$C -X POST https://$SITE/api/auth/register -H 'content-type: application/json' \
  -d '{\"email\":\"compose@t.com\",\"username\":\"composetest\",\"password\":\"secret123\"}' \
  | sed -n 's/.*\"token\":\"\([^\"]*\)\".*/\1/p')
[ -n \"\$TOKEN\" ] && echo 'PASS register over the API' || echo 'FAIL register over the API'

A=\"authorization: Bearer \$TOKEN\"
\$C -o /dev/null -X POST https://$SITE/api/bookmarks -H 'content-type: application/json' \
  -H \"\$A\" -d '{\"url\":\"https://caddyserver.com\",\"title\":\"Caddy\",\"tags\":\"tls,proxy\"}'
\$C -o /dev/null -X POST https://$SITE/api/bookmarks -H 'content-type: application/json' \
  -H \"\$A\" -d '{\"url\":\"https://go.dev\",\"title\":\"Go\",\"tags\":\"go\"}'

\$C \"https://$SITE/api/bookmarks?q=%23tls\" -H \"\$A\" | grep -q '\"title\":\"Caddy\"' \
  && echo 'PASS tag search through the proxy' || echo 'FAIL tag search through the proxy'
\$C \"https://$SITE/api/bookmarks?q=-%23tls\" -H \"\$A\" | grep -q '\"title\":\"Go\"' \
  && echo 'PASS negated search through the proxy' || echo 'FAIL negated search through the proxy'
" 2>/dev/null)

while IFS= read -r line; do
  case "$line" in
    PASS*) ok "${line#PASS }" ;;
    FAIL*) bad "${line#FAIL }" ;;
  esac
done <<< "$output"

info "restarting the api to check persistence in the volume"
"${COMPOSE[@]}" restart api >/dev/null 2>&1
sleep 4

persist=$(docker run --rm --network "$NET" --entrypoint sh curlimages/curl:latest -c "
R=\"--resolve $SITE:443:$IP --resolve $SITE:80:$IP\"
curl -s \$R -o /tmp/ca.crt http://$SITE/root.crt
TOKEN=\$(curl -s \$R --cacert /tmp/ca.crt -X POST https://$SITE/api/auth/login \
  -H 'content-type: application/json' -d '{\"login\":\"composetest\",\"password\":\"secret123\"}' \
  | sed -n 's/.*\"token\":\"\([^\"]*\)\".*/\1/p')
curl -s \$R --cacert /tmp/ca.crt https://$SITE/api/bookmarks -H \"authorization: Bearer \$TOKEN\"
" 2>/dev/null)

echo "$persist" | grep -q '"title":"Caddy"' \
  && ok "data survives the restart (volume)" \
  || bad "data lost after the restart"

echo
if [[ $FAILS -eq 0 ]]; then
  printf '\033[32m✔ compose ok\033[0m\n'
else
  printf '\033[31m✖ %d compose check(s) failed\033[0m\n' "$FAILS"
  exit 1
fi
