#!/bin/sh
set -e
# Fix ownership of bind-mount directories so the bun user can write to them.
# This is a no-op if they are already owned correctly.
chown -R bun:bun /app/config /data 2>/dev/null || true
exec gosu bun "$@"
