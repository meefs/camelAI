#!/bin/sh
set -eu

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"
SYNC_ONLY="${SYNC_ONLY:-}"
R2_MOUNT_READONLY="${R2_MOUNT_READONLY:-}"

is_truthy() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|on|ON) return 0 ;;
    *) return 1 ;;
  esac
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
  rclone sync "$TARGET_DIR" "$REMOTE" --exclude ".keep" 2>&1 | head -20 >&2
  echo "[sandbox] Upload complete." >&2
}

# If R2 env vars aren't configured, just run driver (if not sync-only)
if [ -z "${R2_BUCKET_NAME:-}" ] || [ -z "${R2_ACCOUNT_ID:-}" ] || [ -z "${AWS_ACCESS_KEY_ID:-}" ] || [ -z "${AWS_SECRET_ACCESS_KEY:-}" ]; then
  if [ -n "$SYNC_ONLY" ]; then
    exit 0
  fi
  exit_code=0
  bun /app/driver.mjs || exit_code=$?
  exit "$exit_code"
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
if [ -z "${PROJECT_ID:-}" ]; then
  echo "[sandbox] PROJECT_ID is required but missing." >&2
  exit 1
fi
PROJECT_DIR="$PROJECT_ID"
mkdir -p "$TARGET_DIR/$PROJECT_DIR"

# Seed a starter Workers-for-Platforms project on first run (when the directory is empty).
if [ ! -f "$TARGET_DIR/$PROJECT_DIR/package.json" ] && [ -z "$(ls -A "$TARGET_DIR/$PROJECT_DIR" 2>/dev/null || true)" ]; then
  echo "[sandbox] Seeding starter worker project into ${TARGET_DIR}/${PROJECT_DIR}..." >&2
  cp -a /app/starter-worker/. "$TARGET_DIR/$PROJECT_DIR/"
fi

cd "$TARGET_DIR/$PROJECT_DIR"

exit_code=0
bun /app/driver.mjs || exit_code=$?

sync_to_r2 || true

exit "$exit_code"
