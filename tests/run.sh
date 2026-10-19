#!/usr/bin/env bash
# Runs the whole suite.
#
#   bash tests/run.sh              api, search, yaml, import/export, the address
#                                  bar and the theme
#   bash tests/run.sh --web        adds the browser tests (needs Chrome)
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

heading "saving from the address bar, and the theme (node:test)"
node --test tests/address.test.mjs tests/theme.test.js

heading "yaml, import/export and link titles (node:test)"
node --test tests/yaml.test.js tests/portability.test.js tests/titles.test.js

heading "backend, api and pwa (node:test)"
node --test tests/api.test.js

if want --web; then
  heading "web: the app in a browser"
  bash tests/web.sh
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
