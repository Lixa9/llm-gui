#!/bin/sh
set -e
# Fix ownership of bind-mount directories so the node user can write to them.
# This is a no-op if they are already owned correctly.
chown -R node:node /app/config /data 2>/dev/null || true
exec gosu node "$@"
