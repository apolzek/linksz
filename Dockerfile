# Backend image. No `npm install`: the server uses only Node built-in modules
# (node:sqlite included), so the image is the runtime plus the code.
FROM node:24-alpine

LABEL org.opencontainers.image.title="Bookmarks" \
      org.opencontainers.image.description="Bookmark manager with instant search" \
      org.opencontainers.image.source="https://github.com/nochaosio/bookmarks"

WORKDIR /app

COPY server ./server
COPY web ./web

# Unprivileged user + /data as the database mount point.
RUN addgroup -S bookmarks && adduser -S -G bookmarks bookmarks \
    && mkdir -p /data \
    && chown -R bookmarks:bookmarks /data /app

USER bookmarks

ENV BOOKMARKS_HOST=0.0.0.0 \
    BOOKMARKS_PORT=8787 \
    BOOKMARKS_DB=/data/bookmarks.db

EXPOSE 8787
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.BOOKMARKS_PORT+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/server.js"]
