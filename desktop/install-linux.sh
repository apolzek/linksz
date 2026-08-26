#!/usr/bin/env bash
# Installs on Linux/GNOME:
#   1. daemon autostart (a resident bar opens instantly)
#   2. launchers for the bar and the web UI in the applications menu
#   3. systemd --user service for the backend
#   4. global shortcut on GNOME (default: Super+Space)
#
# Usage:  bash desktop/install-linux.sh [SHORTCUT]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINDING="${1:-<Super>space}"
NAME="Bookmarks"
PYTHON="$(command -v python3)"
CMD="$PYTHON $ROOT/desktop/bookmarks_bar.py"
URL="${BOOKMARKS_URL:-http://127.0.0.1:8787}"

say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

# ---------- 0. toolkit check ----------
if ! "$PYTHON" -c 'import gi' 2>/dev/null && ! "$PYTHON" -c 'import tkinter' 2>/dev/null; then
  warn "neither python3-gi nor python3-tk found."
  warn "install one of them:  sudo apt install python3-gi   (recommended on GNOME)"
fi

# ---------- 1. daemon autostart ----------
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/bookmarks.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Bookmarks (search bar)
Comment=Keeps the bar resident so it opens instantly
Exec=$CMD --daemon
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
say "autostart installed at ~/.config/autostart/bookmarks.desktop"

# ---------- 2. launchers ----------
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/bookmarks.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Bookmarks
Comment=Fast bookmark search
Exec=$CMD
Icon=bookmark-new
Terminal=false
Categories=Utility;
EOF

# A dedicated window for the web UI (the same effect as "install the PWA"), when
# a Chromium-based browser is around.
BROWSER=""
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$(command -v "$b")"; break; fi
done

if [[ -n "$BROWSER" ]]; then
  cat > ~/.local/share/applications/bookmarks-web.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Bookmarks (web)
Comment=Opens your bookmarks in their own window
Exec=$BROWSER --app=$URL
Icon=bookmark-new
Terminal=false
Categories=Utility;
EOF
  say "web window launcher created (using $(basename "$BROWSER"))"
else
  warn "no Chromium browser found: open $URL and use 'Install app'"
fi
say "launchers installed in the applications menu"

# ---------- 3. backend service ----------
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/bookmarks.service <<EOF
[Unit]
Description=Bookmarks backend (API + web)
After=network.target

[Service]
ExecStart=$(command -v node) $ROOT/server/server.js
Restart=on-failure
Environment=BOOKMARKS_PORT=8787

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now bookmarks.service >/dev/null 2>&1 \
  && say "backend running via systemd ($URL)" \
  || warn "systemd --user unavailable; run it by hand: mise run server"

# ---------- 4. GNOME global shortcut ----------
KEY_PATH=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
SCHEMA=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding

if ! command -v gsettings >/dev/null 2>&1; then
  warn "gsettings not found: register the shortcut by hand for: $CMD"
else
  existing=$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings)
  slot=""
  # Reuses the slot when it is already registered. A slot counts as ours when
  # its command points into this checkout, which also catches the ones written
  # before the project was renamed, instead of leaving a dead shortcut behind.
  for i in $(seq 0 20); do
    p="$KEY_PATH/custom$i/"
    if [[ "$existing" == *"$p"* ]]; then
      slot_name="$(gsettings get "$SCHEMA:$p" name 2>/dev/null || true)"
      slot_cmd="$(gsettings get "$SCHEMA:$p" command 2>/dev/null || true)"
      if [[ "$slot_name" == "'$NAME'" || "$slot_cmd" == *"$ROOT/desktop/"* ]]; then slot="$p"; break; fi
    else
      slot="$p"; break
    fi
  done

  if [[ "$existing" != *"$slot"* ]]; then
    if [[ "$existing" == "@as []" || "$existing" == "[]" ]]; then
      new="['$slot']"
    else
      new="${existing%]}, '$slot']"
    fi
    gsettings set org.gnome.settings-daemon.plugins.media-keys custom-keybindings "$new"
  fi

  gsettings set "$SCHEMA:$slot" name "$NAME"
  gsettings set "$SCHEMA:$slot" command "$CMD"
  gsettings set "$SCHEMA:$slot" binding "$BINDING"
  say "global shortcut registered: $BINDING"

  # Super+space is usually taken by the keyboard layout switch: free that key
  # alone, keeping the other shortcuts of the same action (e.g. XF86Keyboard).
  if [[ "$BINDING" == "<Super>space" ]]; then
    for action in switch-input-source switch-input-source-backward; do
      current=$(gsettings get org.gnome.desktop.wm.keybindings "$action" 2>/dev/null || echo "@as []")
      if [[ "$current" == *"<Super>space"* ]]; then
        left=$("$PYTHON" - "$current" <<'PY'
import ast, sys
try:
    binds = ast.literal_eval(sys.argv[1].replace("@as ", "", 1))
except (ValueError, SyntaxError):
    binds = []
binds = [b for b in binds if b not in ("<Super>space", "<Super>Space")]
print("[" + ", ".join(f"'{b}'" for b in binds) + "]" if binds else "@as []")
PY
        )
        gsettings set org.gnome.desktop.wm.keybindings "$action" "$left"
        say "freed <Super>space from $action (left: $left)"
      fi
    done
  fi
fi

# Starts the daemon now so the shortcut works without logging out first.
pgrep -f "bookmarks_bar.py --daemon" >/dev/null || (setsid $CMD --daemon >/dev/null 2>&1 &)

echo
say "done! press $BINDING to open the bar"
say "web: $URL"
