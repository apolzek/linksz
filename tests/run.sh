#!/usr/bin/env bash
# Runs the whole suite.
#
#   bash tests/run.sh              backend + search + desktop
#   bash tests/run.sh --compose    includes the Docker stack (slower)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

heading() { printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '─%.0s' $(seq $((50 - ${#1}))))"; }

heading "search (node:test)"
node --test tests/search.test.js

heading "yaml + import/export (node:test)"
node --test tests/yaml.test.js tests/portability.test.js

heading "backend, api and pwa (node:test)"
node --test tests/api.test.js

heading "desktop and yaml interop (unittest)"
python3 -m unittest discover -s tests -p 'test_*.py' -v

if [[ "${1:-}" == "--compose" ]]; then
  heading "compose: tls, pwa and api on docker"
  bash tests/compose.sh
else
  printf '\n\033[2m(compose not tested, use: bash tests/run.sh --compose)\033[0m\n'
fi

printf '\n\033[32m✔ all green\033[0m\n'
