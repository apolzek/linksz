#!/usr/bin/env bash
# Instala o Vaultmarks no Linux/GNOME:
#   1. autostart do daemon (barra residente = abre instantanea)
#   2. lancador da barra e da PWA no menu de aplicativos
#   3. servico systemd --user do backend
#   4. atalho global no GNOME (padrao: Super+Space)
#
# Uso:  bash desktop/install-linux.sh [ATALHO]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BINDING="${1:-<Super>space}"
NAME="Vaultmarks"
PYTHON="$(command -v python3)"
CMD="$PYTHON $ROOT/desktop/vaultmarks_bar.py"
URL="${VAULTMARKS_URL:-http://127.0.0.1:8787}"

say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }

# ---------- 0. checagem de toolkit ----------
if ! "$PYTHON" -c 'import gi' 2>/dev/null && ! "$PYTHON" -c 'import tkinter' 2>/dev/null; then
  warn "nem python3-gi nem python3-tk encontrados."
  warn "instale um deles:  sudo apt install python3-gi   (recomendado no GNOME)"
fi

# ---------- 1. autostart do daemon ----------
mkdir -p ~/.config/autostart
cat > ~/.config/autostart/vaultmarks.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Vaultmarks (barra de busca)
Comment=Mantem a barra residente para abrir instantaneamente
Exec=$CMD --daemon
X-GNOME-Autostart-enabled=true
NoDisplay=true
EOF
say "autostart instalado em ~/.config/autostart/vaultmarks.desktop"

# ---------- 2. lancadores ----------
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/vaultmarks.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Vaultmarks
Comment=Busca rapida de favoritos
Exec=$CMD
Icon=bookmark-new
Terminal=false
Categories=Utility;
EOF

# Janela dedicada da web (mesmo efeito de "instalar a PWA"), se houver um
# navegador baseado em Chromium por perto.
BROWSER=""
for b in google-chrome google-chrome-stable chromium chromium-browser brave-browser microsoft-edge; do
  if command -v "$b" >/dev/null 2>&1; then BROWSER="$(command -v "$b")"; break; fi
done

if [[ -n "$BROWSER" ]]; then
  cat > ~/.local/share/applications/vaultmarks-web.desktop <<EOF
[Desktop Entry]
Type=Application
Name=Vaultmarks (web)
Comment=Abre o vault em janela propria
Exec=$BROWSER --app=$URL
Icon=bookmark-new
Terminal=false
Categories=Utility;
EOF
  say "lancador da janela web criado (usando $(basename "$BROWSER"))"
else
  warn "nenhum navegador Chromium encontrado — abra $URL e use 'Instalar app'"
fi
say "lancadores instalados no menu de aplicativos"

# ---------- 3. servico do backend ----------
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/vaultmarks.service <<EOF
[Unit]
Description=Vaultmarks backend (API + web)
After=network.target

[Service]
ExecStart=$(command -v node) $ROOT/server/server.js
Restart=on-failure
Environment=VAULTMARKS_PORT=8787

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now vaultmarks.service >/dev/null 2>&1 \
  && say "backend rodando via systemd ($URL)" \
  || warn "systemd --user indisponivel; rode manualmente: mise run server"

# ---------- 4. atalho global do GNOME ----------
KEY_PATH=/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings
SCHEMA=org.gnome.settings-daemon.plugins.media-keys.custom-keybinding

if ! command -v gsettings >/dev/null 2>&1; then
  warn "gsettings nao encontrado — registre o atalho na mao para: $CMD"
else
  existing=$(gsettings get org.gnome.settings-daemon.plugins.media-keys custom-keybindings)
  slot=""
  # Reaproveita o slot se o Vaultmarks ja estiver registrado.
  for i in $(seq 0 20); do
    p="$KEY_PATH/custom$i/"
    if [[ "$existing" == *"$p"* ]]; then
      if [[ "$(gsettings get "$SCHEMA:$p" name 2>/dev/null)" == "'$NAME'" ]]; then slot="$p"; break; fi
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
  say "atalho global registrado: $BINDING"

  # Super+space costuma estar preso a troca de layout de teclado — libera so
  # essa tecla, preservando os outros atalhos da mesma acao (ex.: XF86Keyboard).
  if [[ "$BINDING" == "<Super>space" ]]; then
    for action in switch-input-source switch-input-source-backward; do
      current=$(gsettings get org.gnome.desktop.wm.keybindings "$action" 2>/dev/null || echo "@as []")
      if [[ "$current" == *"<Super>space"* ]]; then
        novo=$("$PYTHON" - "$current" <<'PY'
import ast, sys
try:
    binds = ast.literal_eval(sys.argv[1].replace("@as ", "", 1))
except (ValueError, SyntaxError):
    binds = []
binds = [b for b in binds if b not in ("<Super>space", "<Super>Space")]
print("[" + ", ".join(f"'{b}'" for b in binds) + "]" if binds else "@as []")
PY
        )
        gsettings set org.gnome.desktop.wm.keybindings "$action" "$novo"
        say "liberado <Super>space de $action (restante: $novo)"
      fi
    done
  fi
fi

# Inicia o daemon agora para o atalho ja funcionar sem relogar.
pgrep -f "vaultmarks_bar.py --daemon" >/dev/null || (setsid $CMD --daemon >/dev/null 2>&1 &)

echo
say "pronto! aperte $BINDING para abrir a barra"
say "web: $URL"
