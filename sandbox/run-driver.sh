#!/bin/sh
set -eu

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"
SYNC_ONLY="${SYNC_ONLY:-}"

# If R2 env vars aren't configured, just run driver (if not sync-only)
if [ -z "${R2_BUCKET_NAME:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  if [ -n "$SYNC_ONLY" ]; then
    exit 0
  fi
  exec bun /app/driver.mjs
fi

# Only sync from R2 on first run
if [ ! -f "$FIRST_RUN_MARKER" ]; then
  # Save credentials for entrypoint to use on shutdown (24h TTL, only need to save once)
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
  rclone sync "$REMOTE" "$TARGET_DIR" --exclude ".keep" 2>&1 | head -20 >&2
  echo "[sandbox] Download complete." >&2

  # Mark as synced
  touch "$FIRST_RUN_MARKER"
fi

# If sync-only mode, exit now
if [ -n "$SYNC_ONLY" ]; then
  exit 0
fi

# Create project dir and cd into it
mkdir -p "$TARGET_DIR/project"
cd "$TARGET_DIR/project"

exec bun /app/driver.mjs
