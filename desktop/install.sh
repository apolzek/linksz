#!/usr/bin/env bash
# Instalador do Vaultmarks — despacha para o script do seu sistema.
#
# Uso:  bash desktop/install.sh [ATALHO]
#       bash desktop/install.sh '<Super>b'      # Linux: outro atalho
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
  Linux)  exec bash "$ROOT/desktop/install-linux.sh" "$@" ;;
  Darwin) exec bash "$ROOT/desktop/install-macos.sh" "$@" ;;
  *)
    echo "sistema nao suportado: $(uname -s)" >&2
    echo "o backend roda em qualquer lugar com 'node server/server.js'" >&2
    exit 1
    ;;
esac
