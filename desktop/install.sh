#!/usr/bin/env bash
# Installer: dispatches to the script for your system.
#
# Usage:  bash desktop/install.sh [SHORTCUT]
#         bash desktop/install.sh '<Super>b'      # Linux: another shortcut
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
  Linux)  exec bash "$ROOT/desktop/install-linux.sh" "$@" ;;
  Darwin) exec bash "$ROOT/desktop/install-macos.sh" "$@" ;;
  *)
    echo "unsupported system: $(uname -s)" >&2
    echo "the backend runs anywhere with 'node api/server.js'" >&2
    exit 1
    ;;
esac
