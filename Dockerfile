# Backend image. No `npm install`: the server uses only Node built-in modules
# (node:sqlite included), so the image is the runtime plus the code.
FROM node:24-alpine

# Which commit this image was built from, and when. The pipeline fills them in;
# built by hand they stay empty and the app falls back to asking git.
ARG BOOKMARKS_COMMIT=""
ARG BOOKMARKS_DEPLOYED_AT=""

LABEL org.opencontainers.image.title="Bookmarks" \
      org.opencontainers.image.description="Bookmark manager with instant search" \
      org.opencontainers.image.source="https://github.com/nochaosio/bookmarks.nochaos.io" \
      org.opencontainers.image.revision="${BOOKMARKS_COMMIT}" \
      org.opencontainers.image.created="${BOOKMARKS_DEPLOYED_AT}"

WORKDIR /app

COPY api ./api
COPY web ./web

# Unprivileged user + /data as the database mount point.
RUN addgroup -S bookmarks && adduser -S -G bookmarks bookmarks \
    && mkdir -p /data \
    && chown -R bookmarks:bookmarks /data /app

USER bookmarks

ENV BOOKMARKS_HOST=0.0.0.0 \
    BOOKMARKS_PORT=8787 \
    BOOKMARKS_DB=/data/bookmarks.db \
    BOOKMARKS_COMMIT=${BOOKMARKS_COMMIT} \
    BOOKMARKS_DEPLOYED_AT=${BOOKMARKS_DEPLOYED_AT}

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.BOOKMARKS_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "api/server.js"]
