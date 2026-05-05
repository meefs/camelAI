#!/bin/bash
set -euo pipefail

# Seed workspace uv cache from image cache. The workspace is bind-mounted at
# /home/claude and persists across container restarts.
# Run seeding in the background so it never delays container startup.
if [ -d /opt/uv-cache-seed ]; then
  (
    if ! su -m -s /bin/sh claude -c 'mkdir -p /home/claude/.cache/uv && cp -R -n /opt/uv-cache-seed/. /home/claude/.cache/uv/'; then
      echo "[entrypoint] WARNING: uv cache seed copy failed; continuing without seed cache" >&2
    fi
  ) &
fi

mount_r2_prefix() {
  local label="$1"
  local mount_point="$2"
  local prefix="$3"
  local credentials_file="$4"
  shift 4

  if [ -z "$prefix" ] || [ -z "$credentials_file" ]; then
    echo "[entrypoint] ERROR: missing R2 ${label} mount configuration" >&2
    exit 1
  fi
  if [ ! -r "$credentials_file" ]; then
    echo "[entrypoint] ERROR: R2 ${label} credential file is not readable" >&2
    exit 1
  fi

  mkdir -p "$mount_point"
  AWS_SHARED_CREDENTIALS_FILE="$credentials_file" AWS_REGION=auto \
    goofys \
      --endpoint "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
      --stat-cache-ttl 0 \
      --type-cache-ttl 0 \
      -o allow_other \
      --uid 1001 \
      --gid 1001 \
      --dir-mode 0755 \
      --file-mode 0644 \
      "$@" \
      "$R2_BUCKET_NAME:$prefix" \
      "$mount_point"
}

if [ "${R2_MOUNT_ENABLED:-}" = "1" ]; then
  if ! command -v goofys >/dev/null 2>&1; then
    echo "[entrypoint] ERROR: R2 mount requested but goofys is not installed" >&2
    exit 1
  fi

  mount_r2_prefix "uploads" "/mnt/user-uploads" "${R2_UPLOADS_PREFIX:-}" "${R2_UPLOADS_CREDENTIALS_FILE:-}" -o ro
  mount_r2_prefix "outputs" "/mnt/user-outputs" "${R2_OUTPUTS_PREFIX:-}" "${R2_OUTPUTS_CREDENTIALS_FILE:-}"
fi

exec su -m -s /bin/sh claude -c "HOME=/home/claude exec node -e \"require('http').createServer((req,res)=>{if(req.url==='/health'){res.writeHead(200,{'content-type':'application/json'});res.end('{\\\"status\\\":\\\"ok\\\"}');return;}res.writeHead(404,{'content-type':'application/json'});res.end('{\\\"error\\\":\\\"not found\\\"}');}).listen(8080,'0.0.0.0')\""
