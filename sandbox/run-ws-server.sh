#!/bin/sh
set -eu

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"
R2_MOUNT_READONLY="${R2_MOUNT_READONLY:-}"

# Write proxy credentials to file (read by proxy on each request)
write_proxy_creds() {
  if [ -n "${CHIRIDION_PROXY_TOKEN:-}" ] && [ -n "${CHIRIDION_PROXY_BASE_URL:-}" ] && \
     [ -n "${CHIRIDION_ORG_ID:-}" ]; then
    cat > /tmp/proxy-creds << EOF
CHIRIDION_PROXY_TOKEN=${CHIRIDION_PROXY_TOKEN}
CHIRIDION_PROXY_BASE_URL=${CHIRIDION_PROXY_BASE_URL}
CHIRIDION_ORG_ID=${CHIRIDION_ORG_ID}
EOF
    echo "[sandbox] Updated proxy credentials file" >&2
  fi
}

# Check if R2 is configured
has_r2_config() {
  [ -n "${R2_BUCKET_NAME:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && \
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]
}

# Start integration proxy if configured
start_proxy() {
  if [ -n "${CHIRIDION_PROXY_TOKEN:-}" ] && [ -n "${CHIRIDION_PROXY_BASE_URL:-}" ] && \
     [ -n "${CHIRIDION_ORG_ID:-}" ]; then
    echo "[sandbox] Starting integration proxy on port 8081..." >&2
    node /app/proxy.mjs &
  fi
}

# EXIT trap for R2 sync on shutdown
cleanup() {
  echo "[sandbox] Shutting down, uploading snapshot..." >&2
  node /app/sync.mjs upload "$TARGET_DIR" || true
  echo "[sandbox] Shutdown complete." >&2
}

# If R2 is not configured, just run ws-server
if ! has_r2_config; then
  echo "[sandbox] No R2 credentials, running ws-server without sync" >&2
  write_proxy_creds
  start_proxy
  exec bun /app/ws-server.mjs
fi

# Set up shutdown trap for upload
trap cleanup EXIT

# Download snapshot on first run
if [ ! -f "$FIRST_RUN_MARKER" ]; then
  node /app/sync.mjs download "$TARGET_DIR"
  touch "$FIRST_RUN_MARKER"
fi

# Seed a starter Workers-for-Platforms project on first run (when empty)
if [ ! -f "$TARGET_DIR/package.json" ] && [ -z "$(ls -A "$TARGET_DIR" 2>/dev/null || true)" ]; then
  echo "[sandbox] Seeding starter worker project into ${TARGET_DIR}..." >&2
  cp -a /app/starter-worker/. "$TARGET_DIR/"
fi

cd "$TARGET_DIR"

# Write proxy credentials and start proxy
write_proxy_creds
start_proxy

# Run ws-server (stays running until WebSocket disconnect)
exec bun /app/ws-server.mjs
