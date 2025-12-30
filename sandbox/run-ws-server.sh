#!/bin/sh
set -eu

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"
R2_MOUNT_READONLY="${R2_MOUNT_READONLY:-}"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

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

sync_to_r2() {
  if [ -f /tmp/r2-creds ]; then
    . /tmp/r2-creds
  fi

  if [ -z "${R2_BUCKET_NAME:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
    return 0
  fi

  if is_truthy "${R2_MOUNT_READONLY}"; then
    echo "[sandbox] R2_MOUNT_READONLY set; skipping upload sync." >&2
    return 0
  fi

  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  PREFIX="${R2_PREFIX:-default/}"
  REMOTE="r2:${R2_BUCKET_NAME}/${PREFIX}"

  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
  if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
    export RCLONE_CONFIG_R2_SESSION_TOKEN="$AWS_SESSION_TOKEN"
  fi

  echo "[sandbox] Uploading ${TARGET_DIR} to R2 prefix ${PREFIX}..." >&2
  rclone sync "$TARGET_DIR" "$REMOTE" --exclude ".keep" --timeout 10s --contimeout 5s 2>&1 | head -20 >&2
  echo "[sandbox] Upload complete." >&2
}

# EXIT trap for R2 sync on shutdown
cleanup() {
  echo "[sandbox] Shutting down, syncing to R2..." >&2
  sync_to_r2 || true
  echo "[sandbox] Shutdown complete." >&2
}
trap cleanup EXIT

# If R2 env vars aren't configured, just run ws-server
if [ -z "${R2_BUCKET_NAME:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  echo "[sandbox] No R2 credentials, running ws-server without sync" >&2
  write_proxy_creds

  # Start integration proxy if configured (on port 8081, separate from ws-server on 8080)
  if [ -n "${CHIRIDION_PROXY_TOKEN:-}" ] && [ -n "${CHIRIDION_PROXY_BASE_URL:-}" ] && \
     [ -n "${CHIRIDION_ORG_ID:-}" ]; then
    echo "[sandbox] Starting integration proxy on port 8081..." >&2
    node /app/proxy.mjs &
  fi

  exec bun /app/ws-server.mjs
fi

# Only sync from R2 on first run
if [ ! -f "$FIRST_RUN_MARKER" ]; then
  # Save credentials for EXIT trap (24h TTL)
  cat > /tmp/r2-creds << EOF
AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-}"
R2_ACCOUNT_ID="$R2_ACCOUNT_ID"
R2_BUCKET_NAME="$R2_BUCKET_NAME"
R2_PREFIX="${R2_PREFIX:-default/}"
TARGET_DIR="$TARGET_DIR"
EOF

  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  PREFIX="${R2_PREFIX:-default/}"
  REMOTE="r2:${R2_BUCKET_NAME}/${PREFIX}"

  # Configure rclone for R2
  export RCLONE_CONFIG_R2_TYPE=s3
  export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
  export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
  export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
  export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
  if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
    export RCLONE_CONFIG_R2_SESSION_TOKEN="$AWS_SESSION_TOKEN"
  fi

  echo "[sandbox] Downloading from R2 prefix ${PREFIX} to ${TARGET_DIR}..." >&2
  rclone sync "$REMOTE" "$TARGET_DIR" --exclude ".keep" --timeout 10s --contimeout 5s 2>&1 | head -20 >&2
  echo "[sandbox] Download complete." >&2

  # Mark as synced
  touch "$FIRST_RUN_MARKER"
fi

# Create project dir and cd into it
if [ -z "${PROJECT_ID:-}" ]; then
  echo "[sandbox] PROJECT_ID is required but missing." >&2
  exit 1
fi
PROJECT_DIR="$PROJECT_ID"
mkdir -p "$TARGET_DIR/$PROJECT_DIR"

# Seed a starter Workers-for-Platforms project on first run (when empty)
if [ ! -f "$TARGET_DIR/$PROJECT_DIR/package.json" ] && [ -z "$(ls -A "$TARGET_DIR/$PROJECT_DIR" 2>/dev/null || true)" ]; then
  echo "[sandbox] Seeding starter worker project into ${TARGET_DIR}/${PROJECT_DIR}..." >&2
  cp -a /app/starter-worker/. "$TARGET_DIR/$PROJECT_DIR/"
fi

cd "$TARGET_DIR/$PROJECT_DIR"

# Write proxy credentials
write_proxy_creds

# Start integration proxy if configured (on port 8081)
echo "[sandbox] Checking proxy env vars..." >&2
if [ -n "${CHIRIDION_PROXY_TOKEN:-}" ] && [ -n "${CHIRIDION_PROXY_BASE_URL:-}" ] && \
   [ -n "${CHIRIDION_ORG_ID:-}" ]; then
  echo "[sandbox] Starting integration proxy on port 8081..." >&2
  node /app/proxy.mjs &
else
  echo "[sandbox] Proxy env vars missing, skipping proxy startup" >&2
fi

# Run ws-server (stays running until WebSocket disconnect)
exec bun /app/ws-server.mjs
