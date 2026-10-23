#!/usr/bin/env bash
# The extension in a real Chromium, against the real backend on a throwaway
# vault: connecting through the app, saving the page on screen, search, being
# signed out from the app, the key instead, disconnecting.
#
# --headless=new, because the old headless mode runs no extensions. It
# delivers no input events either (see tests/web.sh), so the driver clicks
# through the DOM, never through the keyboard or the mouse.
#
# Skipped, not failed, without Chromium. Branded Google Chrome ignores
# --load-extension, so it is not used here.
#
# Usage:  bash extension/test/e2e.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CHROME=$(command -v chromium || command -v chromium-browser || true)
if [[ -z "$CHROME" ]]; then
  echo "no chromium on this machine, skipping the extension tests" >&2
  exit 0
fi

WORK=$(mktemp -d)
SERVER_PID=""
CHROME_PID=""
cleanup() {
  [[ -n "$CHROME_PID" ]] && kill "$CHROME_PID" 2>/dev/null || true
  [[ -n "$CHROME_PID" ]] && wait "$CHROME_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  for _ in 1 2 3 4 5 6 7 8 9 10; do rm -rf "$WORK" 2>/dev/null && break; sleep 0.3; done
}
trap cleanup EXIT

read -r APP_PORT CDP_PORT < <(node -e '
  const net = require("node:net");
  const free = () => new Promise((res) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => res(port)); });
  });
  Promise.all([free(), free()]).then((p) => console.log(p.join(" ")));
')

DEV_KEY=$(node -e 'console.log(require("./api/auth").newAccessKey())')
LINKSZ_DB="$WORK/bookmarks.db" LINKSZ_HOST=127.0.0.1 LINKSZ_PORT="$APP_PORT" LINKSZ_DEV_KEY="$DEV_KEY" \
  node api/server.js >"$WORK/server.log" 2>&1 &
SERVER_PID=$!
for _ in $(seq 50); do curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null 2>&1 && break; sleep 0.2; done
curl -sf "http://127.0.0.1:$APP_PORT/api/health" >/dev/null || { echo "the backend never answered"; cat "$WORK/server.log"; exit 1; }

# The Arch wrapper adds ~/.config/chromium-flags.conf to the command line; a
# config dir of its own keeps the person's flags, and extensions, out of it.
XDG_CONFIG_HOME="$WORK/config" "$CHROME" --headless=new --disable-gpu --no-first-run --no-default-browser-check \
  --remote-debugging-port="$CDP_PORT" --user-data-dir="$WORK/profile" \
  --disable-extensions-except="$PWD/extension" --load-extension="$PWD/extension" \
  --window-size=1280,900 about:blank >"$WORK/chrome.log" 2>&1 &
CHROME_PID=$!
for _ in $(seq 60); do curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1 && break; sleep 0.25; done
curl -sf "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null || { echo "chromium never opened its debugging port"; tail -5 "$WORK/chrome.log"; exit 1; }

DEV_KEY="$DEV_KEY" node extension/test/e2e.mjs "http://127.0.0.1:$APP_PORT" "$CDP_PORT"
