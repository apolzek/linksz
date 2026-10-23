#!/usr/bin/env bash
# Installs Linksz from the published images, no clone needed:
#
#   curl -fsSL https://raw.githubusercontent.com/apolzek/linksz/master/install.sh | bash
#   curl -fsSL .../install.sh | bash -s -- --remove     stop it, keep the vault
#
# LINKSZ_HOME (~/.local/share/linksz), LINKSZ_VAULT_DIR ($LINKSZ_HOME/data),
# LINKSZ_WEB_PORT (8080) and LINKSZ_TAG (latest) change the defaults.
set -euo pipefail

NAME=Linksz
REPO=https://raw.githubusercontent.com/apolzek/linksz/master
HOME_DIR=${LINKSZ_HOME:-$HOME/.local/share/linksz}
VAULT_DIR=${LINKSZ_VAULT_DIR:-$HOME_DIR/data}
PORT=${LINKSZ_WEB_PORT:-8080}
TAG=${LINKSZ_TAG:-latest}
URL="http://localhost:$PORT"

say() { printf '\033[1;34m›\033[0m %s\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

compose() { docker compose -p linksz -f "$HOME_DIR/compose.yaml" "$@"; }

if [[ ${1:-} == --remove ]]; then
  [[ -f $HOME_DIR/compose.yaml ]] && compose down
  command -v omarchy-webapp-remove >/dev/null && omarchy-webapp-remove "$NAME" || true
  rm -f "$HOME_DIR/compose.yaml" "$HOME_DIR/.env"
  say "Removed. The vault is still in $VAULT_DIR"
  exit 0
fi

command -v docker >/dev/null || die "Docker is not installed. On Omarchy: Install > Development > Docker."
docker compose version >/dev/null 2>&1 || die "docker compose is missing."
docker info >/dev/null 2>&1 || die "Cannot talk to the docker daemon: is it running, and are you in the docker group?"

# Created here, not by the daemon, so the vault is owned by you and not root.
mkdir -p "$HOME_DIR" "$VAULT_DIR"

cat >"$HOME_DIR/compose.yaml" <<EOF
name: linksz
services:
  api:
    image: ghcr.io/apolzek/linksz-api:\${LINKSZ_TAG:-latest}
    restart: unless-stopped
    environment:
      LINKSZ_HOST: 0.0.0.0
      LINKSZ_PORT: "8787"
      LINKSZ_DB: /data/bookmarks.db
    volumes:
      - \${LINKSZ_VAULT_DIR}:/data
  web:
    image: ghcr.io/apolzek/linksz-web:\${LINKSZ_TAG:-latest}
    restart: unless-stopped
    depends_on:
      api:
        condition: service_healthy
    ports:
      - "127.0.0.1:\${LINKSZ_WEB_PORT:-8080}:80"
EOF
printf 'LINKSZ_VAULT_DIR=%s\nLINKSZ_WEB_PORT=%s\nLINKSZ_TAG=%s\n' "$VAULT_DIR" "$PORT" "$TAG" >"$HOME_DIR/.env"

say "Pulling the images ($TAG)"
compose pull -q
say "Starting it on $URL"
compose up -d --wait

if command -v omarchy-webapp-install >/dev/null; then
  omarchy-webapp-install "$NAME" "$URL" "$REPO/web/icon-512.png" >/dev/null
  say "Added to the app menu: Super+Alt+Space, then type \"linksz\""
fi

say "Done. Open $URL and choose \"Create one\" for a vault, or paste the key of one you have."
say "Vault: $VAULT_DIR    Remove: curl -fsSL $REPO/install.sh | bash -s -- --remove"
