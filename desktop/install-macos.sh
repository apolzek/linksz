#!/usr/bin/env bash
# Installs on macOS (Intel or Apple Silicon):
#   1. backend LaunchAgent (starts at login)
#   2. bar daemon LaunchAgent (resident, so it opens instantly)
#   3. Vaultmarks Bar.app  wakes the bar (this is what you bind the key to)
#   4. Vaultmarks.app      opens the vault in its own window (the PWA)
#
# macOS does not let an arbitrary process register a global shortcut, so the
# last step (binding the key) is manual; the script explains how at the end.
#
# Usage:  bash desktop/install-macos.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="$(command -v python3)"
NODE="$(command -v node || true)"
URL="${VAULTMARKS_URL:-http://127.0.0.1:8787}"
AGENTS="$HOME/Library/LaunchAgents"
APPS="$HOME/Applications"
LOGS="$HOME/Library/Logs/vaultmarks"

say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

mkdir -p "$AGENTS" "$APPS" "$LOGS"

# ---------- 0. checks ----------
if ! "$PYTHON" -c 'import tkinter' 2>/dev/null; then
  warn "this Python has no Tkinter: the bar will not open."
  warn "fix:  brew install python-tk        (Homebrew)"
  warn "or use the system Python:  /usr/bin/python3"
fi
[[ -z "$NODE" ]] && warn "node not found in PATH: the backend will not start"

# Creates a minimal .app bundle: folder + Info.plist + a shell executable.
# LSUIElement=1 hides the Dock icon (the bar is not an ordinary app).
make_app() {
  local name="$1" ident="$2" exec_line="$3" ui_element="$4"
  local app="$APPS/$name.app"
  local bin="${name// /-}"

  rm -rf "$app"
  mkdir -p "$app/Contents/MacOS"

  cat > "$app/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$name</string>
  <key>CFBundleDisplayName</key><string>$name</string>
  <key>CFBundleIdentifier</key><string>$ident</string>
  <key>CFBundleExecutable</key><string>$bin</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>LSUIElement</key><$ui_element/>
</dict>
</plist>
EOF

  printf '#!/bin/bash\n%s\n' "$exec_line" > "$app/Contents/MacOS/$bin"
  chmod +x "$app/Contents/MacOS/$bin"
  say "created $app"
}

# ---------- 1. backend LaunchAgent ----------
if [[ -n "$NODE" ]]; then
  cat > "$AGENTS/dev.vaultmarks.server.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.vaultmarks.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/server/server.js</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>VAULTMARKS_PORT</key><string>8787</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/server.log</string>
  <key>StandardErrorPath</key><string>$LOGS/server.err.log</string>
</dict>
</plist>
EOF
  launchctl bootout "gui/$(id -u)/dev.vaultmarks.server" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$AGENTS/dev.vaultmarks.server.plist" 2>/dev/null \
    || launchctl load -w "$AGENTS/dev.vaultmarks.server.plist" 2>/dev/null \
    || warn "could not load the backend LaunchAgent"
  say "backend registered at login ($URL)"
fi

# ---------- 2. bar daemon LaunchAgent ----------
cat > "$AGENTS/dev.vaultmarks.bar.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>dev.vaultmarks.bar</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON</string>
    <string>$ROOT/desktop/vaultmarks_bar.py</string>
    <string>--daemon</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOGS/bar.log</string>
  <key>StandardErrorPath</key><string>$LOGS/bar.err.log</string>
</dict>
</plist>
EOF
launchctl bootout "gui/$(id -u)/dev.vaultmarks.bar" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$AGENTS/dev.vaultmarks.bar.plist" 2>/dev/null \
  || launchctl load -w "$AGENTS/dev.vaultmarks.bar.plist" 2>/dev/null \
  || warn "could not load the bar LaunchAgent"
say "bar daemon registered at login"

# ---------- 3. the app that wakes the bar ----------
# Runs the same script: it finds the daemon over the socket and only sends "show".
make_app "Vaultmarks Bar" "dev.vaultmarks.bar.launcher" \
  "exec \"$PYTHON\" \"$ROOT/desktop/vaultmarks_bar.py\" \"\$@\"" "true"

# ---------- 4. web window app (PWA) ----------
CHROME=""
for candidate in \
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" \
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
  "/Applications/Chromium.app/Contents/MacOS/Chromium"; do
  [[ -x "$candidate" ]] && { CHROME="$candidate"; break; }
done

if [[ -n "$CHROME" ]]; then
  make_app "Vaultmarks" "dev.vaultmarks.web" \
    "exec \"$CHROME\" --app=$URL" "false"
  say "web window using $(basename "$(dirname "$(dirname "$CHROME")")")"
else
  warn "no Chromium browser found."
  warn "on Safari 17+: open $URL and use File > Add to Dock"
fi

cat <<EOF

$(printf '\033[1;32m✔\033[0m') installed.

Only the global shortcut is left: macOS does not let the app register it alone.
Pick one path:

  Shortcuts.app (native, nothing to install)
    1. Open the Shortcuts app > new shortcut
    2. Action "Open app" > $APPS/Vaultmarks Bar.app
    3. In the details panel, set a Keyboard Shortcut (e.g. Cmd+Space)

  skhd (if you already use it)
    echo 'cmd - space : open -a "Vaultmarks Bar"' >> ~/.skhdrc && skhd --restart-service

  Raycast / Alfred
    point a hotkey at the "Vaultmarks Bar" app

Web: $URL
Logs: $LOGS
EOF
