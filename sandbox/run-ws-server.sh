#!/bin/sh
set -eu

# Container startup script for ws-server.
# Env vars are passed via sandbox.startProcess({ env: ... }).

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"

echo "[sandbox] Starting container..." >&2
echo "[sandbox] ORG_ID=${ORG_ID:-unset}" >&2
echo "[sandbox] R2_BUCKET_NAME=${R2_BUCKET_NAME:-unset}" >&2

# Check if R2 is configured
has_r2_config() {
  [ -n "${R2_BUCKET_NAME:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && \
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]
}

# EXIT trap for R2 sync on shutdown
cleanup() {
  if has_r2_config; then
    echo "[sandbox] Shutting down, uploading snapshot..." >&2
    node /app/sync.mjs upload "$TARGET_DIR" || true
    echo "[sandbox] Shutdown complete." >&2
  fi
}

# If R2 is configured, set up sync
if has_r2_config; then
  echo "[sandbox] R2 configured, setting up sync..." >&2

  # Set up shutdown trap for upload
  trap cleanup EXIT

  # Download snapshot on first run
  if [ ! -f "$FIRST_RUN_MARKER" ]; then
    echo "[sandbox] Downloading R2 snapshot..." >&2
    node /app/sync.mjs download "$TARGET_DIR"
    touch "$FIRST_RUN_MARKER"
    echo "[sandbox] R2 download complete." >&2
  fi

  # Seed a starter Workers-for-Platforms project on first run (when empty)
  if [ ! -f "$TARGET_DIR/package.json" ] && [ -z "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]; then
    echo "[sandbox] Seeding starter worker project into ${TARGET_DIR}..." >&2
    cp -a /app/starter-worker/. "$TARGET_DIR/"
  fi
else
  echo "[sandbox] No R2 credentials, running without sync" >&2
fi

cd "$TARGET_DIR"

echo "[sandbox] Starting ws-server..." >&2

# Run ws-server as main process
exec bun /app/ws-server.mjs
