#!/bin/sh
set -eu

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"
SYNC_ONLY="${SYNC_ONLY:-}"
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
  echo "[sandbox] Checking proxy env vars..." >&2
  echo "[sandbox]   CHIRIDION_PROXY_TOKEN: ${CHIRIDION_PROXY_TOKEN:+set (${#CHIRIDION_PROXY_TOKEN} chars)}${CHIRIDION_PROXY_TOKEN:-not set}" >&2
  echo "[sandbox]   CHIRIDION_PROXY_BASE_URL: ${CHIRIDION_PROXY_BASE_URL:-not set}" >&2
  echo "[sandbox]   CHIRIDION_ORG_ID: ${CHIRIDION_ORG_ID:-not set}" >&2
  if [ -n "${CHIRIDION_PROXY_TOKEN:-}" ] && [ -n "${CHIRIDION_PROXY_BASE_URL:-}" ] && \
     [ -n "${CHIRIDION_ORG_ID:-}" ]; then
    echo "[sandbox] Starting integration proxy on port 8080..." >&2
    node /app/proxy.mjs &
  else
    echo "[sandbox] Proxy env vars missing, skipping proxy startup" >&2
  fi
}

# If R2 is not configured, just run driver
if ! has_r2_config; then
  if [ -n "$SYNC_ONLY" ]; then
    exit 0
  fi
  write_proxy_creds
  start_proxy
  exit_code=0
  bun /app/driver.mjs || exit_code=$?
  exit "$exit_code"
fi

# Download snapshot on first run
if [ ! -f "$FIRST_RUN_MARKER" ]; then
  node /app/sync.mjs download "$TARGET_DIR"
  touch "$FIRST_RUN_MARKER"
fi

# If sync-only mode, exit now
if [ -n "$SYNC_ONLY" ]; then
  exit 0
fi

# Create project dir and cd into it
if [ -z "${PROJECT_ID:-}" ]; then
  echo "[sandbox] PROJECT_ID is required but missing." >&2
  exit 1
fi
PROJECT_DIR="$PROJECT_ID"
mkdir -p "$TARGET_DIR/$PROJECT_DIR"

# Seed a starter Workers-for-Platforms project on first run (when the directory is empty)
if [ ! -f "$TARGET_DIR/$PROJECT_DIR/package.json" ] && [ -z "$(ls -A "$TARGET_DIR/$PROJECT_DIR" 2>/dev/null || true)" ]; then
  echo "[sandbox] Seeding starter worker project into ${TARGET_DIR}/${PROJECT_DIR}..." >&2
  cp -a /app/starter-worker/. "$TARGET_DIR/$PROJECT_DIR/"
fi

cd "$TARGET_DIR/$PROJECT_DIR"

# Write proxy credentials and start proxy
write_proxy_creds
start_proxy

# Run driver
exit_code=0
bun /app/driver.mjs || exit_code=$?

# Upload snapshot on completion
node /app/sync.mjs upload "$TARGET_DIR" || true

exit "$exit_code"
