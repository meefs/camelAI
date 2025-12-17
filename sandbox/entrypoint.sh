#!/bin/sh
# Container entrypoint (PID 1) - handles R2 sync on shutdown

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"

sync_to_r2() {
  # Load saved credentials from first driver run
  if [ -f /tmp/r2-creds ]; then
    . /tmp/r2-creds

    R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
    REMOTE="r2:${R2_BUCKET_NAME}/${R2_PREFIX}"

    # Configure rclone
    export RCLONE_CONFIG_R2_TYPE=s3
    export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
    export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID"
    export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY"
    export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
    if [ -n "${AWS_SESSION_TOKEN:-}" ]; then
      export RCLONE_CONFIG_R2_SESSION_TOKEN="$AWS_SESSION_TOKEN"
    fi

    echo "[entrypoint] Syncing ${TARGET_DIR} to R2 prefix ${R2_PREFIX}..." >&2
    rclone sync "$TARGET_DIR" "$REMOTE" --exclude ".keep" 2>&1 | head -20 >&2
    echo "[entrypoint] Sync complete." >&2
  else
    echo "[entrypoint] No R2 credentials saved, skipping sync." >&2
  fi
}

cleanup() {
  echo "[entrypoint] Received SIGTERM, syncing to R2..." >&2
  sync_to_r2
  exit 0
}

trap cleanup TERM INT

echo "[entrypoint] Container started, waiting for SIGTERM..." >&2

# Keep container alive
while true; do
  sleep 86400 &
  wait $!
done
