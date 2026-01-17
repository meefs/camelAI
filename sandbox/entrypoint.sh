#!/bin/sh
# Container entrypoint - mounts JuiceFS (R2 + SQLite) and starts services.
# Environment variables are passed at container start time via @cloudflare/containers.
#
# Ports:
#   8080 - ws-server (Claude SDK) - runs as claude user
#   9000 - control-plane (exec/fs) - runs as claude user
#
# Version: 2026-01-17-v16
set -eu

echo "[entrypoint] Starting container initialization..." >&2
START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] ORG_ID=${ORG_ID:-unset}" >&2
echo "[entrypoint] WORKSPACE_ID=${WORKSPACE_ID:-unset}" >&2
echo "[entrypoint] R2_BUCKET_NAME=${R2_BUCKET_NAME:-unset}" >&2

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
JUICEFS_META_DIR="${JUICEFS_META_DIR:-/var/lib/juicefs}"
JUICEFS_CACHE_DIR="${JUICEFS_CACHE_DIR:-/tmp/juicefs-cache}"
JUICEFS_UPLOAD_DELAY="${JUICEFS_UPLOAD_DELAY:-60s}"
JUICEFS_BUFFER_SIZE="${JUICEFS_BUFFER_SIZE:-1024}"
JUICEFS_META_UPLOAD_INTERVAL="${JUICEFS_META_UPLOAD_INTERVAL:-60s}"

# Track PIDs for cleanup
WS_PID=""
CONTROL_PID=""
META_UPLOAD_PID=""
MOUNT_SUCCEEDED=""

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

  if [ -f "$JFS_META_FILE" ]; then
    # Use SQLite's .backup command for a safe, consistent backup
    # This handles WAL mode properly and works even if the database is in use
    BACKUP_FILE="/tmp/juicefs-meta-backup.db"
    echo "[entrypoint] Creating SQLite backup..." >&2
    if sqlite3 "$JFS_META_FILE" ".backup '$BACKUP_FILE'" 2>/dev/null; then
      node /app/r2-meta.mjs upload "$BACKUP_FILE" || true
      rm -f "$BACKUP_FILE" 2>/dev/null || true
    else
      echo "[entrypoint] WARNING: SQLite backup failed" >&2
    fi
  fi
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

mount_juicefs() {
  if ! has_r2_config; then
    echo "[entrypoint] ERROR: Missing R2 credentials. Required: R2_BUCKET_NAME, R2_ACCOUNT_ID, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY" >&2
    echo "[entrypoint]   R2_BUCKET_NAME=${R2_BUCKET_NAME:-MISSING}" >&2
    echo "[entrypoint]   R2_ACCOUNT_ID=${R2_ACCOUNT_ID:-MISSING}" >&2
    echo "[entrypoint]   AWS_ACCESS_KEY_ID=${AWS_ACCESS_KEY_ID:+set}${AWS_ACCESS_KEY_ID:-MISSING}" >&2
    echo "[entrypoint]   AWS_SECRET_ACCESS_KEY=${AWS_SECRET_ACCESS_KEY:+set}${AWS_SECRET_ACCESS_KEY:-MISSING}" >&2
    return 1
  fi

  ORG_SAFE="$(sanitize_name "${ORG_ID:-org}")"
  WS_SAFE="$(sanitize_name "${WORKSPACE_ID:-ws}")"
  VOLUME_NAME="chiridion-${ORG_SAFE}-${WS_SAFE}"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  # JuiceFS stores data at {bucket}/{volume-name}/ regardless of any prefix in bucket URL
  # Use virtual-hosted style URL for R2: https://bucket.account.r2.cloudflarestorage.com
  JFS_BUCKET_URL="https://${R2_BUCKET_NAME}.${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  JFS_META_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.db"
  JFS_META_URL="sqlite3://${JFS_META_FILE}"

  echo "[entrypoint] JuiceFS config:" >&2
  echo "[entrypoint]   volume: ${VOLUME_NAME}" >&2
  echo "[entrypoint]   bucket: ${JFS_BUCKET_URL}" >&2
  echo "[entrypoint]   storage: ${JFS_BUCKET_URL}/${VOLUME_NAME}/" >&2
  echo "[entrypoint]   meta: ${JFS_META_FILE}" >&2
  echo "[entrypoint]   target: ${TARGET_DIR}" >&2

  mkdir -p "$TARGET_DIR" "$JUICEFS_META_DIR" "$JUICEFS_CACHE_DIR"
  # Ensure claude user owns these directories and any files in them
  chown -R claude:claude "$JUICEFS_CACHE_DIR" 2>/dev/null || true
  chown -R claude:claude "$JUICEFS_META_DIR" 2>/dev/null || true
  chmod -R u+rw "$JUICEFS_META_DIR" 2>/dev/null || true

  JFS_DUMP_FILE="${JUICEFS_META_DIR}/${ORG_SAFE}-${WS_SAFE}.json"

  echo "[entrypoint] Restoring JuiceFS metadata (if present)..." >&2
  META_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  META_DOWNLOAD_LOG="/tmp/meta-download.log"
  RESTORED_FROM=""

  # Export R2_PREFIX for r2-meta.mjs (defaults to org/workspace path)
  export R2_PREFIX="${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}"
  echo "[entrypoint] R2_PREFIX=$R2_PREFIX" >&2

  # Unset AWS_SESSION_TOKEN if empty (AWS SDK sends invalid header if set to empty string)
  if [ -z "${AWS_SESSION_TOKEN:-}" ]; then
    unset AWS_SESSION_TOKEN
  fi

  # Download SQLite metadata directly (no dump/load, just the raw SQLite file)
  # Note: We don't run `juicefs config` to update credentials - the mount command
  # uses current credentials regardless of what's stored in metadata.
  if node /app/r2-meta.mjs download "$JFS_META_FILE" >"$META_DOWNLOAD_LOG" 2>&1; then
    if [ -s "$JFS_META_FILE" ]; then
      echo "[entrypoint] Downloaded SQLite metadata ($(ls -la "$JFS_META_FILE" | awk '{print $5}') bytes)" >&2
      # Ensure claude user can write to the metadata file
      chown claude:claude "$JFS_META_FILE" 2>/dev/null || true
      chmod u+rw "$JFS_META_FILE" 2>/dev/null || true
      RESTORED_FROM="sqlite"
    fi
  fi

  if [ -z "$RESTORED_FROM" ]; then
    echo "[entrypoint] No existing metadata in R2" >&2
  fi

  META_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Metadata restore done (ms: $((META_END_TS - META_START_TS)))" >&2

  if [ -f "$JFS_META_FILE" ] && [ ! -s "$JFS_META_FILE" ]; then
    echo "[entrypoint] Metadata file is empty; discarding." >&2
    rm -f "$JFS_META_FILE"
  fi

  if [ ! -f "$JFS_META_FILE" ]; then
    if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
      echo "[entrypoint] ERROR: Read-only mode but no metadata snapshot found; cannot format." >&2
      return 1
    fi

    echo "[entrypoint] Formatting new JuiceFS volume..." >&2
    FORMAT_LOG="/tmp/juicefs-format.log"
    if su -s /bin/sh claude -c "juicefs format \
      --storage s3 \
      --bucket \"$JFS_BUCKET_URL\" \
      --access-key \"$AWS_ACCESS_KEY_ID\" \
      --secret-key \"$AWS_SECRET_ACCESS_KEY\" \
      ${AWS_SESSION_TOKEN:+--session-token \"$AWS_SESSION_TOKEN\"} \
      \"$JFS_META_URL\" \
      \"$VOLUME_NAME\"" >"$FORMAT_LOG" 2>&1; then
      echo "[entrypoint] Format succeeded" >&2
      upload_juicefs_meta
    else
      echo "[entrypoint] ERROR: JuiceFS format failed:" >&2
      cat "$FORMAT_LOG" >&2
      return 1
    fi
  else
    echo "[entrypoint] Using existing metadata: $(ls -la "$JFS_META_FILE" | awk '{print $5}') bytes" >&2
  fi

  JFS_READONLY_FLAG=""
  if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
    JFS_READONLY_FLAG="-r"
    echo "[entrypoint] Read-only mode enabled" >&2
  fi

  echo "[entrypoint] Mounting JuiceFS at ${TARGET_DIR}..." >&2
  MOUNT_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  CLAUDE_UID="$(id -u claude)"
  CLAUDE_GID="$(id -g claude)"
  echo "[entrypoint] Mount user: claude (uid=$CLAUDE_UID, gid=$CLAUDE_GID)" >&2

  # Check FUSE device availability
  if [ ! -c /dev/fuse ]; then
    echo "[entrypoint] ERROR: /dev/fuse device not found" >&2
    return 1
  fi
  echo "[entrypoint] /dev/fuse: $(ls -la /dev/fuse)" >&2

  JUICEFS_MOUNT_LOG="/tmp/juicefs-mount.log"
  JUICEFS_STDERR_LOG="/tmp/juicefs-mount-stderr.log"

  # Run mount in foreground mode, backgrounded by shell
  # This avoids JuiceFS's internal daemon forking which can fail in containers
  #
  # NOTE: NEVER use allow_other option with JuiceFS - it breaks file ownership.
  # Use user_id/group_id options instead to control mount permissions.
  echo "[entrypoint] Starting JuiceFS mount (daemon mode)..." >&2
  MOUNT_CMD="juicefs mount \"$JFS_META_URL\" \"$TARGET_DIR\" \
    --backup-meta 0 \
    --cache-dir \"$JUICEFS_CACHE_DIR\" \
    --upload-delay \"$JUICEFS_UPLOAD_DELAY\" \
    --buffer-size \"$JUICEFS_BUFFER_SIZE\" \
    --prefix-internal \
    -o user_id=$CLAUDE_UID,group_id=$CLAUDE_GID \
    --writeback \
    --no-syslog \
    -v \
    $JFS_READONLY_FLAG \
    -d"
  echo "[entrypoint] Mount command: $MOUNT_CMD" >&2
  su -s /bin/sh claude -c "$MOUNT_CMD" >"$JUICEFS_MOUNT_LOG" 2>"$JUICEFS_STDERR_LOG"
  MOUNT_EXIT=$?
  echo "[entrypoint] JuiceFS mount exit code: $MOUNT_EXIT" >&2

  MOUNT_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"

  # Check if mount succeeded (daemon mode returns after mount is ready)
  if [ "$MOUNT_EXIT" -ne 0 ]; then
    echo "[entrypoint] ERROR: JuiceFS mount failed" >&2
    echo "[entrypoint] === stdout ===" >&2
    cat "$JUICEFS_MOUNT_LOG" >&2 || true
    echo "[entrypoint] === stderr ===" >&2
    cat "$JUICEFS_STDERR_LOG" >&2 || true
    return 1
  fi

  # Verify mount point is actually mounted
  if ! grep -q " $TARGET_DIR " /proc/mounts 2>/dev/null; then
    echo "[entrypoint] ERROR: JuiceFS mount command succeeded but mount point not found" >&2
    echo "[entrypoint] === stdout ===" >&2
    cat "$JUICEFS_MOUNT_LOG" >&2 || true
    echo "[entrypoint] === stderr ===" >&2
    cat "$JUICEFS_STDERR_LOG" >&2 || true
    return 1
  fi

  echo "[entrypoint] JuiceFS mounted successfully (ms: $((MOUNT_END_TS - MOUNT_START_TS)))" >&2
  MOUNT_SUCCEEDED="1"
  return 0
}

# Cleanup function for shutdown
cleanup() {
  echo "[entrypoint] Shutting down..." >&2

  if [ -n "${WS_PID:-}" ] && kill -0 "$WS_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping ws-server (PID: $WS_PID)..." >&2
    kill "$WS_PID" 2>/dev/null || true
    wait "$WS_PID" 2>/dev/null || true
  fi

  if [ -n "${CONTROL_PID:-}" ] && kill -0 "$CONTROL_PID" 2>/dev/null; then
    echo "[entrypoint] Stopping control-plane (PID: $CONTROL_PID)..." >&2
    kill "$CONTROL_PID" 2>/dev/null || true
    wait "$CONTROL_PID" 2>/dev/null || true
  fi

  if grep -q " $TARGET_DIR " /proc/mounts 2>/dev/null; then
    echo "[entrypoint] Unmounting JuiceFS..." >&2
    juicefs umount "$TARGET_DIR" 2>/dev/null || fusermount -u "$TARGET_DIR" 2>/dev/null || true
  fi

  if [ -n "${META_UPLOAD_PID:-}" ] && kill -0 "$META_UPLOAD_PID" 2>/dev/null; then
    kill "$META_UPLOAD_PID" 2>/dev/null || true
    wait "$META_UPLOAD_PID" 2>/dev/null || true
  fi

  # Only upload metadata if mount was successful (avoid overwriting good data with bad)
  if [ "$MOUNT_SUCCEEDED" = "1" ]; then
    upload_juicefs_meta
  else
    echo "[entrypoint] Skipping metadata upload (mount was not successful)" >&2
  fi

  fusermount -u /mnt/user-uploads 2>/dev/null || true
  fusermount -u /mnt/user-outputs 2>/dev/null || true

  echo "[entrypoint] Shutdown complete." >&2
}

trap cleanup EXIT TERM INT

if ! mount_juicefs; then
  echo "[entrypoint] Fatal: JuiceFS mount failed." >&2
  exit 1
fi
start_meta_upload_loop

if has_r2_config; then
  echo "[entrypoint] Mounting R2 file sharing directories..." >&2
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"

  mkdir -p /mnt/user-uploads /mnt/user-outputs
  chown claude:claude /mnt/user-uploads /mnt/user-outputs

  GOOFYS_LOG="/tmp/goofys-uploads.log"
  if su -s /bin/sh claude -c "goofys --endpoint '$R2_ENDPOINT' \
      '${R2_BUCKET_NAME}:${R2_BASE}user-uploads' /mnt/user-uploads" >"$GOOFYS_LOG" 2>&1; then
    echo "[entrypoint] Mounted /mnt/user-uploads" >&2
  else
    echo "[entrypoint] WARNING: Failed to mount /mnt/user-uploads:" >&2
    cat "$GOOFYS_LOG" >&2 || true
  fi

  GOOFYS_LOG="/tmp/goofys-outputs.log"
  if su -s /bin/sh claude -c "goofys --endpoint '$R2_ENDPOINT' \
      '${R2_BUCKET_NAME}:${R2_BASE}user-outputs' /mnt/user-outputs" >"$GOOFYS_LOG" 2>&1; then
    echo "[entrypoint] Mounted /mnt/user-outputs" >&2
  else
    echo "[entrypoint] WARNING: Failed to mount /mnt/user-outputs:" >&2
    cat "$GOOFYS_LOG" >&2 || true
  fi
fi

# Install skills to claude's config directory
echo "[entrypoint] Installing skills..." >&2
SKILLS_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"

su -s /bin/sh claude -c "mkdir -p \"$TARGET_DIR/.claude/skills\"" >/dev/null 2>&1 || true
su -s /bin/sh claude -c "cp -r /app/skills/. \"$TARGET_DIR/.claude/skills/\"" >/dev/null 2>&1 || true

SKILLS_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Skills installed (ms: $((SKILLS_END_TS - SKILLS_START_TS)))" >&2

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

echo "[entrypoint] Starting control-plane server on port 9000..." >&2
CP_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && node /app/control-plane.mjs" &
CONTROL_PID=$!
echo "[entrypoint] Control-plane PID: $CONTROL_PID" >&2

sleep 0.1
if ! kill -0 "$CONTROL_PID" 2>/dev/null; then
  echo "[entrypoint] ERROR: Control-plane failed to start!" >&2
  exit 1
fi
CP_READY_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Control-plane process ready (ms: $((CP_READY_TS - CP_START_TS)))" >&2

echo "[entrypoint] Starting ws-server as claude user on port 8080..." >&2
WS_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && bun /app/ws-server.mjs" &
WS_PID=$!
echo "[entrypoint] ws-server PID: $WS_PID" >&2
WS_READY_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] ws-server process started (ms: $((WS_READY_TS - WS_START_TS)))" >&2

END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Initialization complete (ms: $((END_TS - START_TS)))" >&2

wait "$WS_PID"
WS_EXIT=$?
echo "[entrypoint] ws-server exited with code: $WS_EXIT" >&2

exit $WS_EXIT
