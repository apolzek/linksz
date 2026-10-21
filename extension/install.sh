#!/usr/bin/env bash
# Loads the extension into Chromium on every start, the way Omarchy loads its
# own: a path in the --load-extension line of ~/.config/chromium-flags.conf.
#
#   bash extension/install.sh            add it (restart Chromium to load it)
#   bash extension/install.sh --remove   take it out again
#
# Branded Google Chrome ignores --load-extension; there, open
# chrome://extensions, turn on Developer mode and "Load unpacked" this folder.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FLAGS="${CHROMIUM_FLAGS_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/chromium-flags.conf}"

mkdir -p "$(dirname "$FLAGS")"
touch "$FLAGS"

# The paths on the --load-extension line, one per line, without this one.
others() {
  sed -n 's/^--load-extension=//p' "$FLAGS" | tr ',' '\n' | grep -vxF "$DIR" | grep -v '^$' || true
}

# Rewrites the --load-extension line where it is, or adds one at the end; an
# empty list drops the line.
write() {
  local line="" tmp
  [[ -n $1 ]] && line="--load-extension=$(paste -sd, <<<"$1")"
  tmp=$(mktemp)
  awk -v line="$line" '
    /^--load-extension=/ { if (!done && line != "") print line; done = 1; next }
    { print }
    END { if (!done && line != "") print line }
  ' "$FLAGS" >"$tmp"
  cp "$FLAGS" "$FLAGS.bak"
  cat "$tmp" >"$FLAGS"
  rm -f "$tmp"
}

if [[ ${1:-} == --remove ]]; then
  write "$(others)"
  echo "Removed from $FLAGS (the previous file is $FLAGS.bak). Restart Chromium."
  exit 0
fi

if sed -n 's/^--load-extension=//p' "$FLAGS" | tr ',' '\n' | grep -qxF "$DIR"; then
  echo "Already in $FLAGS."
else
  write "$(others; echo "$DIR")"
  echo "Added to $FLAGS (the previous file is $FLAGS.bak)."
fi
echo "Restart Chromium, then click the Bookmarks button and \"Connect through the app\"."
