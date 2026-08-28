# The PWA, served by nginx, with /api proxied to the api container.
#
# Built from the repository root so the image carries exactly what the backend
# serves in a local install: the same web/ directory, nothing generated.
FROM nginx:1.29-alpine

ARG BOOKMARKS_COMMIT=""
ARG BOOKMARKS_DEPLOYED_AT=""

LABEL org.opencontainers.image.title="Bookmarks web" \
      org.opencontainers.image.description="Self-hosted bookmark manager with instant substring search" \
      org.opencontainers.image.source="https://github.com/nochaosio/bookmarks.nochaos.io" \
      org.opencontainers.image.revision="${BOOKMARKS_COMMIT}" \
      org.opencontainers.image.created="${BOOKMARKS_DEPLOYED_AT}"

# The base image lags behind Alpine's own security updates by days; upgrading
# here is what keeps the scan in CI from failing on a CVE fixed upstream.
RUN apk --no-cache upgrade

COPY web/nginx.conf /etc/nginx/conf.d/default.conf
COPY web/ /usr/share/nginx/html/
# Config and Dockerfile are build inputs, not something to serve.
RUN rm -f /usr/share/nginx/html/nginx.conf /usr/share/nginx/html/Dockerfile

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=3s --retries=3 \
  CMD wget -qO /dev/null http://127.0.0.1/ || exit 1
