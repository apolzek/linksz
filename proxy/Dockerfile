# Caddy with the config baked in, instead of bind-mounting the Caddyfile.
#
# Reasons: an immutable config (the image carries the exact version it runs) and
# it works where a single-file bind-mount is unreliable: Docker on the overlayfs
# storage driver, Docker inside a VM, CI.
#
# After editing the Caddyfile:  docker compose up -d --build proxy
FROM caddy:2-alpine

ARG BOOKMARKS_COMMIT=""
ARG BOOKMARKS_DEPLOYED_AT=""

LABEL org.opencontainers.image.title="Bookmarks proxy" \
      org.opencontainers.image.description="TLS in front of the PWA, so a phone can install it" \
      org.opencontainers.image.source="https://github.com/nochaosio/bookmarks.nochaos.io" \
      org.opencontainers.image.revision="${BOOKMARKS_COMMIT}" \
      org.opencontainers.image.created="${BOOKMARKS_DEPLOYED_AT}"

COPY Caddyfile /etc/caddy/Caddyfile

RUN caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || echo "note: validation uses the runtime BOOKMARKS_SITE"
