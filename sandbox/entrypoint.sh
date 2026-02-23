#!/bin/bash
set -euo pipefail

# Seed workspace uv cache from image cache. The workspace is bind-mounted at
# /home/claude and persists across container restarts.
# Run seeding in the background so it never delays control-plane startup.
if [ -d /opt/uv-cache-seed ]; then
  (
    if ! su -m -s /bin/sh claude -c 'mkdir -p /home/claude/.cache/uv && cp -R -n /opt/uv-cache-seed/. /home/claude/.cache/uv/'; then
      echo "[entrypoint] WARNING: uv cache seed copy failed; continuing without seed cache" >&2
    fi
  ) &
fi

# R2 mounts are handled by the host via bind-mounts — no in-container FUSE needed.
exec su -m -s /bin/sh claude -c 'HOME=/home/claude exec bun run /opt/chiridion/control-plane.mjs'
