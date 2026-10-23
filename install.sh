#!/usr/bin/env bash
# Installs Linksz as a desktop app: no Docker, no nginx, no clone.
#
#   curl -fsSL https://raw.githubusercontent.com/apolzek/linksz/master/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --remove     take it out, keep the vault
#
# The backend serves the PWA and the API on one origin by itself, so the whole
# app is Node running api/server.js on 127.0.0.1, kept up by a systemd user
# service, and a launcher that opens it in its own window. Running it again
# updates it in place. For a server, in containers, see install-docker.sh.
#
# LINKSZ_HOME (~/.local/share/linksz), LINKSZ_VAULT_DIR ($LINKSZ_HOME/data),
# LINKSZ_PORT (8080) and LINKSZ_REF (master) change the defaults.
# LINKSZ_SOURCE installs from a checkout on disk instead of GitHub.
set -euo pipefail

NAME=Linksz
REPO=apolzek/linksz
RAW=https://raw.githubusercontent.com/$REPO/master
HOME_DIR=${LINKSZ_HOME:-$HOME/.local/share/linksz}
VAULT_DIR=${LINKSZ_VAULT_DIR:-$HOME_DIR/data}
PORT=${LINKSZ_PORT:-8080}
REF=${LINKSZ_REF:-master}
SOURCE=${LINKSZ_SOURCE:-}
# localhost and not 127.0.0.1: a PWA needs a secure context, and the browser
# only grants one to plain http on localhost. It is also the origin the Docker
# install used, so a browser that was signed in there still is.
URL="http://localhost:$PORT"

UNIT_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user
UNIT=linksz.service
APPS_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/applications
ICON_DIR=${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/256x256/apps

say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

user_systemctl() { systemctl --user "$@"; }

if [[ ${1:-} == --remove ]]; then
  [[ -x $HOME_DIR/app/extension/install.sh ]] && bash "$HOME_DIR/app/extension/install.sh" --remove >/dev/null 2>&1 || true
  user_systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  rm -f "$UNIT_DIR/$UNIT" "$APPS_DIR/$NAME.desktop" "$ICON_DIR/linksz.png"
  user_systemctl daemon-reload >/dev/null 2>&1 || true
  rm -rf "$HOME_DIR/app" "$HOME_DIR/bin"
  say "Removed. The vault is still in $VAULT_DIR"
  exit 0
fi

command -v systemctl >/dev/null || die "This needs systemd, to keep the backend running for your user."
command -v curl >/dev/null || die "curl is missing."

# Node with node:sqlite built in: 22.13 or later. The one in PATH when it has
# it, otherwise mise's (Omarchy ships mise), otherwise ask for the package.
has_sqlite() { "$1" --no-warnings -e 'require("node:sqlite")' >/dev/null 2>&1; }
NODE=$(command -v node || true)
if [[ $NODE == */mise/shims/* ]]; then NODE=$(mise which node 2>/dev/null || true); fi
if [[ -z $NODE ]] || ! has_sqlite "$NODE"; then
  if command -v mise >/dev/null; then
    say "Installing Node 24 with mise"
    mise install -q node@24
    NODE=$(mise where node@24)/bin/node
  fi
fi
[[ -n $NODE ]] && has_sqlite "$NODE" \
  || die "Linksz needs Node 22.13 or later. On Omarchy or Arch: sudo pacman -S nodejs"

# The Docker install of before lives in the same directory and answers on the
# same port. Two backends on one vault is what to avoid, so it goes, and the
# vault stays where it is.
if [[ -f $HOME_DIR/compose.yaml ]] && command -v docker >/dev/null; then
  say "Stopping the Docker install it replaces (the vault stays)"
  docker compose -p linksz -f "$HOME_DIR/compose.yaml" down >/dev/null 2>&1 || true
  rm -f "$HOME_DIR/compose.yaml" "$HOME_DIR/.env"
fi

# Stopped first so the port check below only sees someone else.
user_systemctl stop "$UNIT" >/dev/null 2>&1 || true
if command -v ss >/dev/null && [[ -n $(ss -Hltn "sport = :$PORT") ]]; then
  die "Port $PORT is taken by something else (docker ps, or ss -ltnp). Free it, or run again with LINKSZ_PORT=<port>."
fi

# The code: api/ and web/, and the browser extension, which loads from a
# folder on disk. Into a new directory first, so a
# failed download leaves the installed version alone.
mkdir -p "$HOME_DIR" "$VAULT_DIR"
NEW=$(mktemp -d "$HOME_DIR/app.XXXXXX")
trap 'rm -rf "$NEW"' EXIT
if [[ -n $SOURCE ]]; then
  say "Copying it from $SOURCE"
  cp -r "$SOURCE/api" "$SOURCE/web" "$SOURCE/extension" "$NEW/"
  rm -rf "$NEW/extension/test"
  COMMIT=$(git -C "$SOURCE" rev-parse --short HEAD 2>/dev/null || true)
else
  # The commit first, then the tarball of that commit: what runs is exactly
  # what the version in Settings says.
  COMMIT=$(curl -fsSL -H 'Accept: application/vnd.github.sha' \
    "https://api.github.com/repos/$REPO/commits/$REF" 2>/dev/null || true)
  [[ $COMMIT =~ ^[0-9a-f]{40}$ ]] || COMMIT=""
  say "Downloading ${COMMIT:0:7}${COMMIT:+ }($REF)"
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/${COMMIT:-$REF}" \
    | tar -xz -C "$NEW" --strip-components=1 --wildcards '*/api' '*/web' '*/extension' --exclude '*/extension/test'
  COMMIT=${COMMIT:0:7}
fi
# Build inputs of the web image, not something to serve.
rm -f "$NEW/web/Dockerfile" "$NEW/web/nginx.conf" "$NEW/api/Dockerfile" "$NEW/api/entrypoint.sh"
chmod 755 "$NEW"
rm -rf "$HOME_DIR/app"
mv "$NEW" "$HOME_DIR/app"
trap - EXIT

mkdir -p "$UNIT_DIR"
cat >"$UNIT_DIR/$UNIT" <<EOF
[Unit]
Description=Linksz, the bookmark vault at $URL

[Service]
ExecStart=$NODE --disable-warning=ExperimentalWarning $HOME_DIR/app/api/server.js
Environment=LINKSZ_HOST=127.0.0.1
Environment=LINKSZ_PORT=$PORT
Environment=LINKSZ_DB=$VAULT_DIR/bookmarks.db
Environment=LINKSZ_COMMIT=$COMMIT
Environment=LINKSZ_DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
Restart=on-failure

[Install]
WantedBy=default.target
EOF

# The launcher: starts the backend if it is not up, then opens the window.
# Omarchy's own web app launcher where there is one, which gives it a window
# of its own in the default browser; any Chromium otherwise; the browser last.
mkdir -p "$HOME_DIR/bin"
cat >"$HOME_DIR/bin/linksz" <<EOF
#!/usr/bin/env bash
URL=$URL
systemctl --user start $UNIT
for _ in \$(seq 50); do
  curl -fsS --max-time 1 "\$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.1
done
if command -v omarchy-launch-webapp >/dev/null; then exec omarchy-launch-webapp "\$URL"; fi
for b in chromium google-chrome-stable google-chrome brave; do
  command -v "\$b" >/dev/null && exec setsid "\$b" --app="\$URL" >/dev/null 2>&1
done
exec xdg-open "\$URL"
EOF
chmod +x "$HOME_DIR/bin/linksz"

mkdir -p "$APPS_DIR" "$ICON_DIR"
cp "$HOME_DIR/app/web/icon-512.png" "$ICON_DIR/linksz.png"
gtk-update-icon-cache "${ICON_DIR%/256x256/apps}" >/dev/null 2>&1 || true
cat >"$APPS_DIR/$NAME.desktop" <<EOF
[Desktop Entry]
Version=1.0
Name=$NAME
Comment=Bookmarks with instant search
Exec=$HOME_DIR/bin/linksz
Terminal=false
Type=Application
Icon=linksz
Categories=Network;Utility;
StartupNotify=true
EOF

user_systemctl daemon-reload
user_systemctl enable "$UNIT" >/dev/null 2>&1
user_systemctl restart "$UNIT"
for _ in $(seq 50); do
  curl -fsS --max-time 1 "$URL/api/health" >/dev/null 2>&1 && break
  sleep 0.1
done
curl -fsS --max-time 2 "$URL/api/health" >/dev/null 2>&1 \
  || die "It did not come up on $URL. What it said: journalctl --user -u $UNIT"

say "Running on $URL, started with your session"
say "In the app menu: Super+Alt+Space, then type \"linksz\""
say "Browser extension: bash $HOME_DIR/app/extension/install.sh, then restart Chromium"
say "Vault: $VAULT_DIR    Logs: journalctl --user -u $UNIT"
say "Remove: curl -fsSL $RAW/install.sh | bash -s -- --remove"
