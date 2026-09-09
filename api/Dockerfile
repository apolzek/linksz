# The API. No `npm install`: the server uses only Node built-in modules
# (node:sqlite included), so the image is the runtime plus the code.
#
# Built from the repository root, not from api/, because the server shares the
# search engine with the browser and that file lives in web/. Writing the engine
# twice to keep the contexts tidy would be the wrong trade.
FROM node:24-alpine

# Which commit this image was built from, and when. The pipeline fills them in;
# built by hand they stay empty and the app falls back to asking git.
ARG BOOKMARKS_COMMIT=""
ARG BOOKMARKS_DEPLOYED_AT=""

LABEL org.opencontainers.image.title="Bookmarks API" \
      org.opencontainers.image.description="Self-hosted bookmark manager with instant substring search" \
      org.opencontainers.image.source="https://github.com/nochaosio/bookmarks.nochaos.io" \
      org.opencontainers.image.revision="${BOOKMARKS_COMMIT}" \
      org.opencontainers.image.created="${BOOKMARKS_DEPLOYED_AT}"

WORKDIR /app

COPY api ./api
# The one file the API needs from the frontend: the shared search engine.
COPY web/search.js ./web/search.js
COPY api/entrypoint.sh /usr/local/bin/entrypoint.sh

# Unprivileged user + /data as the database mount point.
#
# npm and corepack go with it: this app has no dependencies and never installs
# anything at runtime, so all they add is a pile of bundled packages with their
# own CVEs, which is what the image scan in CI keeps finding.
# The base image lags behind Alpine's own security updates by days; upgrading
# here is what keeps the scan in CI from failing on a CVE that is already fixed
# upstream. Runs before anything else so the layer caches on its own.
# su-exec is what the entrypoint drops privileges with: the container starts as
# root only long enough to make the bind-mounted vault writable by the uid that
# owns it on the host, and the server itself never runs as root.
RUN apk --no-cache upgrade \
    && apk add --no-cache su-exec \
    && addgroup -S bookmarks && adduser -S -G bookmarks bookmarks \
    && mkdir -p /data \
    && chown -R bookmarks:bookmarks /data /app \
    && chmod +x /usr/local/bin/entrypoint.sh \
    && rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
              /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
              /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# No `USER` on purpose: the entrypoint starts as root, resolves which uid owns
# the vault and drops to it. See api/entrypoint.sh.

ENV BOOKMARKS_HOST=0.0.0.0 \
    BOOKMARKS_PORT=8787 \
    BOOKMARKS_DB=/data/bookmarks.db \
    BOOKMARKS_COMMIT=${BOOKMARKS_COMMIT} \
    BOOKMARKS_DEPLOYED_AT=${BOOKMARKS_DEPLOYED_AT}

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.BOOKMARKS_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "api/server.js"]
