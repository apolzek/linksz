#!/usr/bin/env bash
# Adds Bookmarks to the Omarchy app launcher, as a web app with its own window
# and the app's own icon. Omarchy's app menu (Super+Alt+Space) lists every
# .desktop entry in ~/.local/share/applications, which is where
# omarchy-webapp-install writes it.
#
#   bash omarchy/install.sh            install, for http://localhost:$BOOKMARKS_WEB_PORT
#   bash omarchy/install.sh --remove   take it out of the launcher
#
# It does not start the stack: that is `docker compose up -d --build`.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

NAME="Bookmarks"

if [[ ${1:-} == --remove ]]; then
  command -v omarchy-webapp-remove >/dev/null || { echo "omarchy-webapp-remove not found: is this Omarchy?" >&2; exit 1; }
  omarchy-webapp-remove "$NAME"
  exit 0
fi

command -v omarchy-webapp-install >/dev/null || { echo "omarchy-webapp-install not found: is this Omarchy?" >&2; exit 1; }

# The port the stack publishes, from .env when there is one. localhost on
# purpose: a PWA needs a secure context, and localhost is one without TLS.
PORT=8080
if [[ -f .env ]]; then
  v=$(sed -n 's/^BOOKMARKS_WEB_PORT=\([0-9]\+\).*/\1/p' .env | tail -1)
  [[ -n $v ]] && PORT=$v
fi
URL="http://localhost:$PORT"

omarchy-webapp-install "$NAME" "$URL" "$PWD/web/icon-512.png"

echo "Installed: $NAME -> $URL"
echo "Open the app menu (Super+Alt+Space) and type \"bookmarks\"."
curl -fsS --max-time 3 "$URL/api/health" >/dev/null 2>&1 \
  || echo "Note: nothing answers on $URL yet. Start it with: docker compose up -d --build"
