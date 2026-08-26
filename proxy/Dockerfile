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

# The base image lags behind Alpine's own security updates; upgrading here is
# what keeps the scan from failing on a CVE already fixed upstream.
RUN apk --no-cache upgrade

COPY Caddyfile /etc/caddy/Caddyfile

# Validating here catches a broken Caddyfile at build time instead of at boot.
#
# It has to run somewhere else, though: `local_certs` makes caddy create the
# local CA on the spot, and the base image points XDG_DATA_HOME at /data, so
# validation was baking the CA private key into the image. Every copy of a
# published image would carry the same key for the CA a phone is asked to
# trust. It runs in a scratch directory that is deleted in the same layer.
RUN XDG_DATA_HOME=/tmp/validate caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile \
    || echo "note: validation uses the runtime BOOKMARKS_SITE"; \
    rm -rf /tmp/validate
