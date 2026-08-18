#!/usr/bin/env bash
# Roda a suite inteira.
#
#   bash tests/run.sh              backend + busca + desktop
#   bash tests/run.sh --compose    inclui a stack Docker (mais lento)
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

titulo() { printf '\n\033[1m── %s %s\033[0m\n' "$1" "$(printf '─%.0s' $(seq $((50 - ${#1}))))"; }

titulo "busca (node:test)"
node --test tests/search.test.js

titulo "yaml + import/export (node:test)"
node --test tests/yaml.test.js tests/portability.test.js

titulo "backend, api e pwa (node:test)"
node --test tests/api.test.js

titulo "desktop e interop yaml (unittest)"
python3 -m unittest discover -s tests -p 'test_*.py' -v

if [[ "${1:-}" == "--compose" ]]; then
  titulo "compose: tls, pwa e api no docker"
  bash tests/compose.sh
else
  printf '\n\033[2m(compose nao testado — use: bash tests/run.sh --compose)\033[0m\n'
fi

printf '\n\033[32m✔ tudo verde\033[0m\n'
