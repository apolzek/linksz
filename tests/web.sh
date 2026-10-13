#!/usr/bin/env bash
# Frontend tests: the app in a real browser.
#
# The node suite exercises the API and the engines; this one covers what only
# exists once a browser is running the page. It brings up the backend on a
# throwaway vault, opens the app in headless Chrome and drives it over the
# DevTools protocol, with no dependency beyond the browser already installed.
#
# Skipped, not failed, where there is no Chrome: the rest of the suite still
# means something on a machine without one.
#
# Usage:  bash tests/web.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CHROME=$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)
if [[ -z "$CHROME" ]]; then
  echo "no chrome on this machine, skipping the web tests" >&2
  exit 0
fi

WORK=$(mktemp -d)
SERVER_PID=""
CHROME_PID=""

cleanup() {
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
  # Chrome writes to its profile on the way out; removing it before the
  # process is gone leaves a half-deleted directory behind.
  [[ -n "$CHROME_PID" ]] && wait "$CHROME_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  # Its helper processes can outlive it by a moment, still writing.
  for _ in 1 2 3 4 5 6 7 8 9 10; do rm -rf "$WORK" 2>/dev/null && break; sleep 0.3; done
}
trap cleanup EXIT

# Free ports, asked of the kernel rather than guessed.
read -r APP_PORT CDP_PORT < <(node -e '
  const net = require("node:net");
  const free = () => new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
  Promise.all([free(), free()]).then((p) => console.log(p.join(" ")));
')

# The fixtures the driver feeds to the file input. Written here so the test owns
# them and no personal export is ever needed to run it.
mkdir -p "$WORK/fixtures"
cat > "$WORK/fixtures/browser-export.html" <<'EOF'
<!DOCTYPE NETSCAPE-Bookmark-file-1>
<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">
<TITLE>Bookmarks</TITLE>
<DL><p>
    <DT><H3 PERSONAL_TOOLBAR_FOLDER="true">Bookmarks bar</H3>
    <DL><p>
        <DT><A HREF="https://na-barra.example">Direct on the bar</A>
        <DT><H3>Work</H3>
        <DL><p>
            <DT><A HREF="https://k8s.example">Kubernetes</A>
        </DL><p>
    </DL><p>
</DL><p>
EOF
cat > "$WORK/fixtures/browser-profile.json" <<'EOF'
{"checksum":"x","version":1,"roots":{
  "bookmark_bar":{"type":"folder","name":"Bookmarks bar","children":[
    {"type":"folder","name":"Reading","children":[
      {"type":"url","name":"From the profile","url":"https://do-perfil.example","date_added":"13428098755418102"}]}]},
  "other":{"type":"folder","name":"Other bookmarks","children":[]}}}
EOF
cat > "$WORK/fixtures/vault.yaml" <<'EOF'
folders:
  work/infra:
  - title: From the vault
    url: https://do-vault.example
    category: infra
    tags: yaml
EOF

# A known key for the throwaway vault, made fresh on every run.
DEV_KEY=$(node -e 'console.log(require("./api/auth").newAccessKey())')

echo "starting the backend on a throwaway vault"
BOOKMARKS_DB="$WORK/bookmarks.db" \
BOOKMARKS_HOST=127.0.0.1 \
BOOKMARKS_PORT="$APP_PORT" \
BOOKMARKS_DEV_KEY="$DEV_KEY" \
  node api/server.js >"$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 50); do
  curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && break
  sleep 0.2
done
curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null || { echo "the backend never answered"; cat "$WORK/server.log"; exit 1; }

# A vault with something in it, so the list has rows to act on.
TOKEN=$(curl -s -X POST "http://127.0.0.1:$APP_PORT/api/auth/key" -H 'content-type: application/json' \
  -d "{\"key\":\"$DEV_KEY\"}" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')
for i in 1 2 3; do
  curl -s -o /dev/null -X POST "http://127.0.0.1:$APP_PORT/api/bookmarks" \
    -H 'content-type: application/json' -H "authorization: Bearer $TOKEN" \
    -d "{\"url\":\"https://exemplo-$i.example\",\"title\":\"Bookmark $i\",\"folder\":\"pasta/$i\",\"category\":\"cat\",\"tags\":\"t$i\"}"
done

# --headless, not --headless=new: the new one accepts Input events and delivers
# none of them. The URL goes on the command line because navigating over the
# protocol kills input for the rest of the session.
echo "opening the app in $(basename "$CHROME")"
"$CHROME" --headless --disable-gpu --no-first-run --no-default-browser-check \
  --remote-debugging-port="$CDP_PORT" --user-data-dir="$WORK/profile" \
  --window-size=1280,1000 "http://127.0.0.1:$APP_PORT/" >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 60); do
  curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break
  sleep 0.25
done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null || { echo "chrome never opened its debugging port"; tail -5 "$WORK/chrome.log"; exit 1; }

WEB_FIXTURES="$WORK/fixtures" DEV_KEY="$DEV_KEY" node tests/web.mjs "http://127.0.0.1:$APP_PORT/" "$CDP_PORT"
