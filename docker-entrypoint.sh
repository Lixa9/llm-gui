#!/bin/sh
set -e
if [ "$(id -u)" = "0" ]; then
  # Running as root — fix bind-mount ownership then drop to node user
  chown -R node:node /app/config 2>/dev/null || true
  exec gosu node "$@"
else
  # Already non-root (rootless Docker, Podman, or explicit user: directive)
  # Host is responsible for ensuring the read-only config mount is accessible
  exec "$@"
fi
