#!/bin/sh
# Container entrypoint - mounts JuiceFS (R2 + SQLite) and starts services.
# Environment variables are passed at container start time via @cloudflare/containers.
#
# Ports:
#   8080 - ws-server (Claude SDK) - runs as claude user
#   9000 - control-plane (exec/fs) - runs as claude user
#
# Version: 2026-01-16-v1
set -eu

echo "[entrypoint] Starting container initialization..." >&2
START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] ORG_ID=${ORG_ID:-unset}" >&2
echo "[entrypoint] WORKSPACE_ID=${WORKSPACE_ID:-unset}" >&2
echo "[entrypoint] R2_BUCKET_NAME=${R2_BUCKET_NAME:-unset}" >&2

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
JUICEFS_META_DIR="${JUICEFS_META_DIR:-/var/lib/juicefs}"
JUICEFS_CACHE_DIR="${JUICEFS_CACHE_DIR:-/tmp/juicefs-cache}"
JUICEFS_UPLOAD_DELAY="${JUICEFS_UPLOAD_DELAY:-5s}"
JUICEFS_META_UPLOAD_INTERVAL="${JUICEFS_META_UPLOAD_INTERVAL:-60s}"

# Track PIDs for cleanup
WS_PID=""
CONTROL_PID=""
META_UPLOAD_PID=""

# Check if R2 is configured
has_r2_config() {
  [ -n "${R2_BUCKET_NAME:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && \
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]
}

sanitize_name() {
  local sanitized
  sanitized="$(echo "$1" | tr -c 'a-zA-Z0-9-' '-' | tr -s '-' | cut -c1-20)"
  if [ -z "$sanitized" ]; then
    sanitized="x"
  fi
  echo "$sanitized"
}

ensure_trailing_slash() {
  case "$1" in
    */) echo "$1" ;;
    *) echo "$1/" ;;
  esac
}

mount_juicefs() {
  if ! has_r2_config; then
    echo "[entrypoint] No R2 credentials, running without JuiceFS mount." >&2
    return 1
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  VOLUME_NAME="chiridion-${ORG_SAFE}-${WS_SAFE}"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  JFS_PREFIX="${R2_BASE}juicefs/"
  JFS_BUCKET_URL="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${R2_BUCKET_NAME}/${JFS_PREFIX}"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"
  JFS_META_URL="sqlite3://${JFS_META_FILE}"
  echo "[entrypoint] JuiceFS volume: ${VOLUME_NAME}" >&2
  echo "[entrypoint] JuiceFS bucket URL: ${JFS_BUCKET_URL}" >&2

  mkdir -p "$TARGET_DIR" "$JUICEFS_META_DIR" "$JUICEFS_CACHE_DIR"
  chown -R claude:claude "$JUICEFS_CACHE_DIR" 2>/dev/null || true
  if [ -w /etc/fuse.conf ] && ! grep -q '^user_allow_other' /etc/fuse.conf; then
    echo "user_allow_other" >> /etc/fuse.conf
  fi

  echo "[entrypoint] Restoring JuiceFS metadata (if present)..." >&2
  META_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  node /app/r2-meta.mjs download "$JFS_META_FILE" || true
  META_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Metadata restore done (ms: $((META_END_TS - META_START_TS)))" >&2

  chown -R claude:claude "$JUICEFS_META_DIR" 2>/dev/null || true

  if [ -f "$JFS_META_FILE" ] && [ ! -s "$JFS_META_FILE" ]; then
    echo "[entrypoint] Metadata snapshot is empty; discarding." >&2
    rm -f "$JFS_META_FILE"
  fi

  if [ ! -f "$JFS_META_FILE" ]; then
    if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
      echo "[entrypoint] Read-only mode set but no metadata snapshot found; cannot format." >&2
      return 1
    fi

    echo "[entrypoint] Formatting new JuiceFS volume..." >&2
    if su -s /bin/sh claude -c "juicefs format \
      --storage s3 \
      --bucket \"$JFS_BUCKET_URL\" \
      --access-key \"$AWS_ACCESS_KEY_ID\" \
      --secret-key \"$AWS_SECRET_ACCESS_KEY\" \
      ${AWS_SESSION_TOKEN:+--session-token \"$AWS_SESSION_TOKEN\"} \
      \"$JFS_META_URL\" \
      \"$VOLUME_NAME\""; then
      upload_juicefs_meta
    fi
  fi

  JFS_READONLY_FLAG=""
  if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
    JFS_READONLY_FLAG="-r"
  fi

  try_mount_juicefs() {
    echo "[entrypoint] Mounting JuiceFS at ${TARGET_DIR}..." >&2
    MOUNT_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
    su -s /bin/sh claude -c "juicefs mount \"$JFS_META_URL\" \"$TARGET_DIR\" \
      --backup-meta 0 \
      --cache-dir \"$JUICEFS_CACHE_DIR\" \
      --upload-delay \"$JUICEFS_UPLOAD_DELAY\" \
      --prefix-internal \
      -o allow_other \
      --writeback \
      $JFS_READONLY_FLAG \
      -d" || true
    MOUNT_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
    echo "[entrypoint] Mount command issued (ms: $((MOUNT_END_TS - MOUNT_START_TS)))" >&2

    for i in 1 2 3 4 5 6 7 8 9 10; do
      if grep -q " $TARGET_DIR " /proc/mounts; then
        echo "[entrypoint] JuiceFS mounted." >&2
        return 0
      fi
      sleep 0.2
    done
    return 1
  }

  if try_mount_juicefs; then
    return 0
  fi

  if [ -f /var/log/juicefs.log ]; then
    echo "[entrypoint] JuiceFS log (tail):" >&2
    tail -n 200 /var/log/juicefs.log >&2 || true
  fi

  echo "[entrypoint] ERROR: JuiceFS mount failed; refusing to continue with local filesystem." >&2
  return 1
}

upload_juicefs_meta() {
  if ! has_r2_config; then
    return 0
  fi
  if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
    return 0
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"

  node /app/r2-meta.mjs upload "$JFS_META_FILE" || true
}

start_meta_upload_loop() {
  if [ -z "${JUICEFS_META_UPLOAD_INTERVAL:-}" ]; then
    return 0
  fi
  if ! has_r2_config; then
    return 0
  fi
  if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
    return 0
  fi
  if [ -n "${META_UPLOAD_PID:-}" ] && kill -0 "$META_UPLOAD_PID" 2>/dev/null; then
    return 0
  fi

  (
    while true; do
      sleep "$JUICEFS_META_UPLOAD_INTERVAL" || true
      upload_juicefs_meta
    done
  ) &
  META_UPLOAD_PID=$!
}

# Cleanup function for shutdown
cleanup() {
  echo "[entrypoint] Shutting down..." >&2

  # Kill ws-server if running
  if [ -n "${WS_PID:-}" ] && kill -0 "$WS_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping ws-server (PID: $WS_PID)..." >&2
    kill "$WS_PID" 2>/dev/null || true
    wait "$WS_PID" 2>/dev/null || true
  fi

  # Kill control-plane if running
  if [ -n "${CONTROL_PID:-}" ] && kill -0 "$CONTROL_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping control-plane (PID: $CONTROL_PID)..." >&2
    kill "$CONTROL_PID" 2>/dev/null || true
    wait "$CONTROL_PID" 2>/dev/null || true
  fi

  # Unmount JuiceFS
  if grep -q " $TARGET_DIR " /proc/mounts 2>/dev/null; then
    echo "[entrypoint] Unmounting JuiceFS..." >&2
    juicefs umount "$TARGET_DIR" 2>/dev/null || fusermount -u "$TARGET_DIR" 2>/dev/null || true
  fi

  if [ -n "${META_UPLOAD_PID:-}" ] && kill -0 "$META_UPLOAD_PID" 2>/dev/null; then
    kill "$META_UPLOAD_PID" 2>/dev/null || true
    wait "$META_UPLOAD_PID" 2>/dev/null || true
  fi

  upload_juicefs_meta

  # Unmount R2 goofys mounts
  fusermount -u /mnt/user-uploads 2>/dev/null || true
  fusermount -u /mnt/user-outputs 2>/dev/null || true

  echo "[entrypoint] Shutdown complete." >&2
}

# Trap signals for graceful shutdown
trap cleanup EXIT TERM INT

# Mount JuiceFS workspace (required)
if ! mount_juicefs; then
  echo "[entrypoint] Fatal: JuiceFS mount failed." >&2
  exit 1
fi
start_meta_upload_loop

# Mount R2 paths via goofys for file sharing with user
if has_r2_config; then
  echo "[entrypoint] Mounting R2 file sharing directories..." >&2
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"

  # Create mount directories
  mkdir -p /mnt/user-uploads /mnt/user-outputs

  # Mount user-uploads (files uploaded by user via web UI)
  if goofys --endpoint "$R2_ENDPOINT" -o allow_other --uid "$(id -u claude)" --gid "$(id -g claude)" \
      "${R2_BUCKET_NAME}:${R2_BASE}user-uploads" /mnt/user-uploads 2>&1; then
    echo "[entrypoint] Mounted /mnt/user-uploads" >&2
  else
    echo "[entrypoint] WARNING: Failed to mount /mnt/user-uploads" >&2
  fi

  # Mount user-outputs (files created for user to download)
  if goofys --endpoint "$R2_ENDPOINT" -o allow_other --uid "$(id -u claude)" --gid "$(id -g claude)" \
      "${R2_BUCKET_NAME}:${R2_BASE}user-outputs" /mnt/user-outputs 2>&1; then
    echo "[entrypoint] Mounted /mnt/user-outputs" >&2
  else
    echo "[entrypoint] WARNING: Failed to mount /mnt/user-outputs" >&2
  fi
fi

# Ensure workspace directory exists (in case JuiceFS isn't mounted)
if ! grep -q " $TARGET_DIR " /proc/mounts; then
  mkdir -p "$TARGET_DIR"
fi

# Install skills to claude's config directory
echo "[entrypoint] Installing skills..." >&2
SKILLS_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
su -s /bin/sh claude -c "mkdir -p \"$TARGET_DIR/.claude/skills\" && cp -r /app/skills/. \"$TARGET_DIR/.claude/skills/\""
SKILLS_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Skills installed (ms: $((SKILLS_END_TS - SKILLS_START_TS)))" >&2

# Write env vars to a file that claude user can source
cat > /tmp/ws-env.sh << ENVEOF
export ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}'
export ORG_ID='${ORG_ID:-}'
export WORKSPACE_ID='${WORKSPACE_ID:-}'
export R2_BUCKET_NAME='${R2_BUCKET_NAME:-}'
export R2_ACCOUNT_ID='${R2_ACCOUNT_ID:-}'
export R2_MOUNT_DIR='${R2_MOUNT_DIR:-}'
export R2_PREFIX='${R2_PREFIX:-}'
export JUICEFS_META_DIR='${JUICEFS_META_DIR:-}'
export JUICEFS_CACHE_DIR='${JUICEFS_CACHE_DIR:-}'
export AWS_ACCESS_KEY_ID='${AWS_ACCESS_KEY_ID:-}'
export AWS_SECRET_ACCESS_KEY='${AWS_SECRET_ACCESS_KEY:-}'
export AWS_SESSION_TOKEN='${AWS_SESSION_TOKEN:-}'
export CLOUDFLARE_ACCOUNT_ID='${CLOUDFLARE_ACCOUNT_ID:-}'
export CLOUDFLARE_API_TOKEN='${CLOUDFLARE_API_TOKEN:-}'
export CLOUDFLARE_API_BASE_URL='${CLOUDFLARE_API_BASE_URL:-}'
export CF_DISPATCH_NAMESPACE='${CF_DISPATCH_NAMESPACE:-}'
export WORKER_BASE_URL='${WORKER_BASE_URL:-}'
ENVEOF
chmod 644 /tmp/ws-env.sh

# Start control-plane server as claude user (runs on port 9000)
echo "[entrypoint] Starting control-plane server on port 9000..." >&2
CP_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && node /app/control-plane.mjs" &
CONTROL_PID=$!
echo "[entrypoint] Control-plane PID: $CONTROL_PID" >&2

# Wait for control-plane to be ready
sleep 0.1
if ! kill -0 "$CONTROL_PID" 2>/dev/null; then
  echo "[entrypoint] ERROR: Control-plane failed to start!" >&2
  exit 1
fi
CP_READY_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Control-plane process ready (ms: $((CP_READY_TS - CP_START_TS)))" >&2

# Start ws-server as claude user (runs on port 8080)
# Run in foreground (no exec) so the shell stays alive for the trap
echo "[entrypoint] Starting ws-server as claude user on port 8080..." >&2
WS_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && bun /app/ws-server.mjs" &
WS_PID=$!
echo "[entrypoint] ws-server PID: $WS_PID" >&2
WS_READY_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] ws-server process started (ms: $((WS_READY_TS - WS_START_TS)))" >&2

END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Initialization complete (ms: $((END_TS - START_TS)))" >&2

# Wait for ws-server - when it exits, the cleanup trap will run
wait "$WS_PID"
WS_EXIT=$?
echo "[entrypoint] ws-server exited with code: $WS_EXIT" >&2

# Exit with ws-server's exit code (cleanup runs via EXIT trap)
exit $WS_EXIT
