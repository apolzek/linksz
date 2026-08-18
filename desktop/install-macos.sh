#!/usr/bin/env bash
# Instala o Vaultmarks no macOS (Intel ou Apple Silicon):
#   1. LaunchAgent do backend (sobe no login)
#   2. LaunchAgent do daemon da barra (residente = abre instantanea)
#   3. Vaultmarks Bar.app  — acorda a barra (e o que voce liga ao atalho)
#   4. Vaultmarks.app      — abre o vault em janela propria (a PWA)
#
# O macOS nao deixa um processo qualquer registrar atalho global, entao o
# ultimo passo (ligar a tecla) e manual — o script explica como no fim.
#
# Uso:  bash desktop/install-macos.sh
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

# ---------- 0. checagens ----------
if ! "$PYTHON" -c 'import tkinter' 2>/dev/null; then
  warn "este Python nao tem Tkinter — a barra nao vai abrir."
  warn "conserto:  brew install python-tk        (Homebrew)"
  warn "ou use o Python do sistema:  /usr/bin/python3"
fi
[[ -z "$NODE" ]] && warn "node nao encontrado no PATH — o backend nao vai subir"

# Cria um .app bundle minimo: pasta + Info.plist + um executavel shell.
# LSUIElement=1 esconde o icone do Dock (a barra nao e um app comum).
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
  say "criado $app"
}

# ---------- 1. LaunchAgent do backend ----------
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
    || warn "nao consegui carregar o LaunchAgent do backend"
  say "backend registrado no login ($URL)"
fi

# ---------- 2. LaunchAgent do daemon da barra ----------
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
  || warn "nao consegui carregar o LaunchAgent da barra"
say "daemon da barra registrado no login"

# ---------- 3. app que acorda a barra ----------
# Roda o mesmo script: ele detecta o daemon pelo socket e so manda "show".
make_app "Vaultmarks Bar" "dev.vaultmarks.bar.launcher" \
  "exec \"$PYTHON\" \"$ROOT/desktop/vaultmarks_bar.py\" \"\$@\"" "true"

# ---------- 4. app da janela web (PWA) ----------
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
  say "janela web usando $(basename "$(dirname "$(dirname "$CHROME")")")"
else
  warn "nenhum navegador Chromium encontrado."
  warn "no Safari 17+: abra $URL e use Arquivo > Adicionar ao Dock"
fi

cat <<EOF

$(printf '\033[1;32m✔\033[0m') instalado.

Falta so o atalho global — o macOS nao deixa o app registrar sozinho.
Escolha um caminho:

  Shortcuts.app (nativo, sem instalar nada)
    1. Abra o app Atalhos > novo atalho
    2. Acao "Abrir app" > $APPS/Vaultmarks Bar.app
    3. No painel de detalhes, defina uma Tecla de Atalho (ex.: ⌘Espaco)

  skhd (se voce ja usa)
    echo 'cmd - space : open -a "Vaultmarks Bar"' >> ~/.skhdrc && skhd --restart-service

  Raycast / Alfred
    aponte um hotkey para o app "Vaultmarks Bar"

Web: $URL
Logs: $LOGS
EOF
