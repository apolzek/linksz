#!/bin/sh
# Picks the uid the server runs as, then drops to it.
#
# /data is a bind mount, so what decides whether SQLite can create the vault is
# the ownership on the host, not the image's own user. Compose cannot run
# `id -u`, so a hardcoded `user:` in the compose file only works on a machine
# whose uid happens to match, and fails with `unable to open database file`
# everywhere else.
#
# The order is:
#   1. BOOKMARKS_UID / BOOKMARKS_GID, when someone states them;
#   2. otherwise whoever owns the vault directory on the host, which is the
#      right answer by construction: the file stays readable and writable from
#      both sides;
#   3. and if that is root, which only happens when the directory did not exist
#      and the docker daemon created it, the image's own unprivileged user,
#      because nothing here needs to run as root.
set -eu

DB="${BOOKMARKS_DB:-/data/bookmarks.db}"
DATA_DIR=$(dirname "$DB")

# Already unprivileged: `docker run --user` or compose's `user:` won the
# decision, there is nothing to drop to and no way to chown anything.
if [ "$(id -u)" != "0" ]; then
  exec "$@"
fi

mkdir -p "$DATA_DIR"

uid="${BOOKMARKS_UID:-$(stat -c %u "$DATA_DIR")}"
gid="${BOOKMARKS_GID:-$(stat -c %g "$DATA_DIR")}"

if [ "$uid" = "0" ]; then
  uid=$(id -u bookmarks)
  gid=$(id -g bookmarks)
fi

# Only when it is not already right: the vault can be a large directory the
# host user owns, and chowning it on every boot would be work for nothing.
if [ "$(stat -c %u "$DATA_DIR")" != "$uid" ] || [ "$(stat -c %g "$DATA_DIR")" != "$gid" ]; then
  chown -R "$uid:$gid" "$DATA_DIR"
fi

exec su-exec "$uid:$gid" "$@"
