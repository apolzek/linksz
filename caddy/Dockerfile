# Caddy with the config baked in, instead of bind-mounting the Caddyfile.
#
# Reasons: an immutable config (the image carries the exact version it runs) and
# it works where a single-file bind-mount is unreliable: Docker on the overlayfs
# storage driver, Docker inside a VM, CI.
#
# After editing the Caddyfile:  docker compose up -d --build caddy
FROM caddy:2-alpine

COPY Caddyfile /etc/caddy/Caddyfile

RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || echo "note: validation uses the runtime BOOKMARKS_SITE"
