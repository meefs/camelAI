#!/bin/bash
set -euo pipefail

# Mount R2 buckets inside the container if credentials are available.
# This runs non-blocking — control plane starts regardless of mount success.

if [ -n "${R2_TEMP_ACCESS_KEY_ID:-}" ] && [ -n "${R2_TEMP_SECRET_ACCESS_KEY:-}" ] && [ -n "${R2_ENDPOINT:-}" ] && [ -n "${R2_BUCKET_NAME:-}" ]; then
  PREFIX="${R2_PREFIX:-}"

  cat > /tmp/rclone-r2.conf <<RCLONEEOF
[r2]
type = s3
provider = Cloudflare
access_key_id = ${R2_TEMP_ACCESS_KEY_ID}
secret_access_key = ${R2_TEMP_SECRET_ACCESS_KEY}
session_token = ${R2_TEMP_SESSION_TOKEN:-}
endpoint = ${R2_ENDPOINT}
RCLONEEOF
  chmod 600 /tmp/rclone-r2.conf

  sudo mkdir -p /mnt/user-uploads /mnt/user-outputs
  sudo chown claude:claude /mnt/user-uploads /mnt/user-outputs

  # Mount user-uploads (read-only)
  rclone mount \
    --daemon \
    --config=/tmp/rclone-r2.conf \
    --read-only \
    --dir-cache-time=5s \
    --vfs-cache-mode=full \
    "r2:${R2_BUCKET_NAME}/${PREFIX}/user-uploads" \
    /mnt/user-uploads 2>/dev/null || echo "[entrypoint] warning: user-uploads mount failed, continuing"

  # Mount user-outputs (read-write with write-back cache)
  rclone mount \
    --daemon \
    --config=/tmp/rclone-r2.conf \
    --dir-cache-time=5s \
    --vfs-cache-mode=writes \
    --vfs-write-back=0 \
    "r2:${R2_BUCKET_NAME}/${PREFIX}/user-outputs" \
    /mnt/user-outputs 2>/dev/null || echo "[entrypoint] warning: user-outputs mount failed, continuing"

  echo "[entrypoint] R2 mounts started for prefix=${PREFIX}"
else
  echo "[entrypoint] R2 credentials not set, skipping mounts"
fi

exec bun run /opt/chiridion/control-plane.mjs
