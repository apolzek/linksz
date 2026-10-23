#!/usr/bin/env bash
# Runs the whole suite.
#
#   bash tests/run.sh              api, search, yaml, import/export, the address
#                                  bar, the theme and the desktop install
#   bash tests/run.sh --web        adds the browser tests: the app (needs Chrome)
#                                  and the extension (needs Chromium)
#   bash tests/run.sh --compose    adds the Docker stack (needs Docker)
#   bash tests/run.sh --all        both
#
# Node built-ins only, no test framework and nothing to install. The two extras
# are opt in because each needs something the machine may not have, and each
# skips itself rather than failing when it is missing.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ARGS=" ${*:-} "
want() { case "$ARGS" in *" $1 "*|*" --all "*) return 0;; *) return 1;; esac; }

heading() { printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '─%.0s' $(seq $((50 - ${#1}))))"; }

heading "search (node:test)"
node --test tests/search.test.js

heading "saving from the address bar, the theme and the frontend units (node:test)"
node --test tests/address.test.mjs tests/theme.test.js tests/frontend.test.mjs

heading "yaml, import/export and link titles (node:test)"
node --test tests/yaml.test.js tests/portability.test.js tests/titles.test.js

heading "backend, api, pwa and sessions (node:test)"
node --test tests/api.test.js tests/sessions.test.js

heading "audit trail: link changes and clicks (node:test)"
node --test tests/audit.test.js

heading "desktop install: the service, the launcher, the menu entry (node:test)"
node --test tests/install.test.mjs

heading "browser extension: its pieces, its client on the real backend, its installer (node:test)"
node --test extension/test/*.test.mjs

if want --web; then
  heading "web: the app in a browser"
  bash tests/web.sh
  heading "web: the extension in chromium"
  bash extension/test/e2e.sh
else
  printf '\n\033[2m(browser not tested, use: bash tests/run.sh --web)\033[0m\n'
fi

if want --compose; then
  heading "compose: the pwa and the api behind nginx"
  bash tests/compose.sh
else
  printf '\n\033[2m(compose not tested, use: bash tests/run.sh --compose)\033[0m\n'
fi

printf '\n\033[32m✔ all green\033[0m\n'
