#!/bin/sh
set -e
# Fix ownership of the config bind-mount so the bun user can write default files.
# This is a no-op if the directory is already owned correctly.
chown -R bun:bun /app/config 2>/dev/null || true
exec gosu bun "$@"
