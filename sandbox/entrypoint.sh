#!/bin/sh
# Container entrypoint - mounts JuiceFS (R2 + SQLite) and starts services.
# Supports migration from old R2 tar backups to JuiceFS.
# Environment variables are passed at container start time via @cloudflare/containers.
#
# Ports:
#   8080 - ws-server (Claude SDK) - runs as claude user
#   9000 - control-plane (exec/fs) - runs as claude user
#
# Version: 2026-01-22-v9-fix-claude-dir-perms
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

# Track PIDs for cleanup (Verdaccio managed by pm2)
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

# Check if a tar backup exists in R2 (for migration)
check_tar_backup_exists() {
  if ! has_r2_config; then
    return 1
  fi

  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  TAR_KEY="${R2_BASE}workspace.tar.zst"

  # Use sync.mjs to check if tar backup exists by attempting to get its size
  if node -e "
    import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    try {
      await client.send(new HeadObjectCommand({ Bucket: '${R2_BUCKET_NAME}', Key: '${TAR_KEY}' }));
      process.exit(0);
    } catch (e) {
      process.exit(1);
    }
  " 2>/dev/null; then
    return 0
  else
    return 1
  fi
}

# Delete tar backup from R2 after successful migration
delete_tar_backup() {
  if ! has_r2_config; then
    return 0
  fi

  R2_BASE="$(ensure_trailing_slash "${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}")"
  TAR_KEY="${R2_BASE}workspace.tar.zst"

  echo "[entrypoint] Deleting old tar backup after migration..." >&2
  node -e "
    import { S3Client, DeleteObjectCommand } from '@aws-sdk/client-s3';
    const client = new S3Client({
      endpoint: 'https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com',
      region: 'auto',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN && { sessionToken: process.env.AWS_SESSION_TOKEN }),
      },
    });
    await client.send(new DeleteObjectCommand({ Bucket: '${R2_BUCKET_NAME}', Key: '${TAR_KEY}' }));
    console.error('[entrypoint] Tar backup deleted.');
  " 2>&1 || echo "[entrypoint] WARNING: Failed to delete tar backup" >&2
}

# Migrate data from tar backup to JuiceFS
migrate_from_tar() {
  echo "[entrypoint] Migrating from R2 tar backup to JuiceFS..." >&2
  MIGRATE_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"

  TEMP_EXTRACT_DIR="/tmp/tar-migration"
  mkdir -p "$TEMP_EXTRACT_DIR"

  # Download and extract tar backup
  echo "[entrypoint] Downloading tar backup for migration..." >&2
  if node /app/sync.mjs download "$TEMP_EXTRACT_DIR"; then
    echo "[entrypoint] Tar backup downloaded and extracted." >&2
  else
    echo "[entrypoint] WARNING: No tar backup found or download failed, starting fresh." >&2
    rm -rf "$TEMP_EXTRACT_DIR"
    return 1
  fi

  # Copy extracted data to JuiceFS mount (already mounted at TARGET_DIR)
  echo "[entrypoint] Copying migrated data to JuiceFS..." >&2
  if [ -d "$TEMP_EXTRACT_DIR" ] && [ "$(ls -A "$TEMP_EXTRACT_DIR" 2>/dev/null)" ]; then
    # Use cp with archive mode to preserve permissions and timestamps
    cp -a "$TEMP_EXTRACT_DIR"/. "$TARGET_DIR"/ 2>/dev/null || true
    # Fix ownership - cp -a runs as root so files may have wrong ownership
    # This ensures claude user can write to all migrated files/directories
    chown -R claude:claude "$TARGET_DIR" 2>/dev/null || true
    echo "[entrypoint] Data migration complete." >&2
  fi

  # Clean up temp directory
  rm -rf "$TEMP_EXTRACT_DIR"

  # Delete the old tar backup from R2
  delete_tar_backup

  MIGRATE_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Migration completed (ms: $((MIGRATE_END_TS - MIGRATE_START_TS)))" >&2
  return 0
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

  echo "[entrypoint] Restoring JuiceFS metadata (if present)..." >&2
  META_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  META_DOWNLOAD_LOG="/tmp/meta-download.log"
  NEEDS_MIGRATION=""

  # Export R2_PREFIX for r2-meta.mjs (defaults to org/workspace path)
  export R2_PREFIX="${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}"
  echo "[entrypoint] R2_PREFIX=$R2_PREFIX" >&2

  # Unset AWS_SESSION_TOKEN if empty (AWS SDK sends invalid header if set to empty string)
  if [ -z "${AWS_SESSION_TOKEN:-}" ]; then
    unset AWS_SESSION_TOKEN
  fi

  # Download SQLite metadata directly (no dump/load, just the raw SQLite file)
  if node /app/r2-meta.mjs download "$JFS_META_FILE" >"$META_DOWNLOAD_LOG" 2>&1; then
    if [ -s "$JFS_META_FILE" ]; then
      echo "[entrypoint] Downloaded SQLite metadata ($(ls -la "$JFS_META_FILE" | awk '{print $5}') bytes)" >&2
      # Ensure claude user can write to the metadata file
      chown claude:claude "$JFS_META_FILE" 2>/dev/null || true
      chmod u+rw "$JFS_META_FILE" 2>/dev/null || true
    fi
  fi

  # If no JuiceFS metadata exists, check for tar backup to migrate
  if [ ! -f "$JFS_META_FILE" ] || [ ! -s "$JFS_META_FILE" ]; then
    echo "[entrypoint] No existing JuiceFS metadata in R2" >&2

    # Check if there's an old tar backup to migrate
    if check_tar_backup_exists; then
      echo "[entrypoint] Found old tar backup - will migrate after mount" >&2
      NEEDS_MIGRATION="1"
    fi
  fi

  META_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Metadata restore done (ms: $((META_END_TS - META_START_TS)))" >&2

  if [ -f "$JFS_META_FILE" ] && [ ! -s "$JFS_META_FILE" ]; then
    echo "[entrypoint] Metadata file is empty; discarding." >&2
    rm -f "$JFS_META_FILE"
  fi

  if [ ! -f "$JFS_META_FILE" ]; then
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

  # Run mount in daemon mode
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

  # Migrate from tar backup if needed (now that JuiceFS is mounted)
  if [ "$NEEDS_MIGRATION" = "1" ]; then
    migrate_from_tar
  fi

  return 0
}

# Cleanup function for shutdown (runs on EXIT, which fires for all termination paths)
cleanup() {
  echo "[entrypoint] Shutting down... (reason: ${SHUTDOWN_REASON:-unknown})" >&2

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

  # Stop Verdaccio via pm2
  echo "[entrypoint] Stopping Verdaccio (pm2)..." >&2
  pm2 stop verdaccio 2>/dev/null || true

  # Unmount JuiceFS
  if grep -q " $TARGET_DIR " /proc/mounts 2>/dev/null; then
    echo "[entrypoint] Unmounting JuiceFS..." >&2
    juicefs umount "$TARGET_DIR" 2>/dev/null || fusermount -u "$TARGET_DIR" 2>/dev/null || true
  fi

  # Stop metadata upload loop
  if [ -n "${META_UPLOAD_PID:-}" ] && kill -0 "$META_UPLOAD_PID" 2>/dev/null; then
    kill "$META_UPLOAD_PID" 2>/dev/null || true
    wait "$META_UPLOAD_PID" 2>/dev/null || true
  fi

  # CRITICAL: Upload metadata to R2 on shutdown
  # Only upload metadata if mount was successful (avoid overwriting good data with bad)
  if [ "$MOUNT_SUCCEEDED" = "1" ]; then
    echo "[entrypoint] Uploading JuiceFS metadata to R2..." >&2
    upload_juicefs_meta
  else
    echo "[entrypoint] Skipping metadata upload (mount was not successful)" >&2
  fi

  # Unmount R2 goofys mounts
  fusermount -u /mnt/user-uploads 2>/dev/null || true
  fusermount -u /mnt/user-outputs 2>/dev/null || true

  echo "[entrypoint] Shutdown complete." >&2
}

# Track shutdown reason for debugging
SHUTDOWN_REASON="unknown"

# Trap EXIT for cleanup, and TERM/INT to convert signals into normal exits.
# In dash (Debian's /bin/sh), EXIT trap doesn't fire on untrapped signals,
# so we must trap TERM/INT to ensure cleanup runs on container shutdown.
trap cleanup EXIT
trap 'SHUTDOWN_REASON="SIGTERM"; echo "[entrypoint] Received SIGTERM (from CF runtime)" >&2; exit 0' TERM
trap 'SHUTDOWN_REASON="SIGINT"; echo "[entrypoint] Received SIGINT" >&2; exit 0' INT

# Start Verdaccio npm registry via pm2 (async - don't wait, it'll be ready by the time it's needed)
# This runs in parallel with JuiceFS mount and other startup tasks
echo "[entrypoint] Starting Verdaccio npm registry (async)..." >&2
pm2 start verdaccio --name verdaccio -- --config /verdaccio/config.yaml >/dev/null 2>&1

# Mount JuiceFS (includes migration from tar if needed)
if ! mount_juicefs; then
  echo "[entrypoint] Fatal: JuiceFS mount failed." >&2
  exit 1
fi

# Start background metadata upload loop
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

# Install skills to claude's config directory
# Only copy SKILL.md files - templates stay in /app and are accessed via create-worker script
echo "[entrypoint] Installing skills..." >&2
SKILLS_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"

# Ensure .claude directory has correct ownership (fixes migrated workspaces with root-owned files)
if [ -d "$TARGET_DIR/.claude" ]; then
  chown -R claude:claude "$TARGET_DIR/.claude" 2>/dev/null || true
fi

su -s /bin/sh claude -c "mkdir -p \"$TARGET_DIR/.claude/skills\"" >/dev/null 2>&1 || true
# Copy only SKILL.md files (preserving directory structure) - templates don't need to be on JuiceFS
for skill_dir in /app/skills/*/; do
  skill_name="$(basename "$skill_dir")"
  if [ -f "${skill_dir}SKILL.md" ]; then
    su -s /bin/sh claude -c "mkdir -p \"$TARGET_DIR/.claude/skills/$skill_name\"" >/dev/null 2>&1 || true
    su -s /bin/sh claude -c "cp \"${skill_dir}SKILL.md\" \"$TARGET_DIR/.claude/skills/$skill_name/\"" >/dev/null 2>&1 || true
  fi
done

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
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && node /app/control-plane.mjs" &
CONTROL_PID=$!
echo "[entrypoint] Control-plane PID: $CONTROL_PID" >&2

# Wait for control-plane to be ready
sleep 0.5
if ! kill -0 "$CONTROL_PID" 2>/dev/null; then
  echo "[entrypoint] ERROR: Control-plane failed to start!" >&2
  exit 1
fi

# Start ws-server as claude user (runs on port 8080)
# Run in foreground (no exec) so the shell stays alive for the trap
echo "[entrypoint] Starting ws-server as claude user on port 8080..." >&2
su -s /bin/sh claude -c ". /tmp/ws-env.sh && cd '$TARGET_DIR' && bun /app/ws-server.mjs" &
WS_PID=$!
echo "[entrypoint] ws-server PID: $WS_PID" >&2

END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] Initialization complete (ms: $((END_TS - START_TS)))" >&2

# Wait for ws-server - when it exits, the cleanup trap will run
wait "$WS_PID"
WS_EXIT=$?
SHUTDOWN_REASON="ws-server-exit-$WS_EXIT"
echo "[entrypoint] ws-server exited with code: $WS_EXIT" >&2

# Exit with ws-server's exit code (cleanup runs via EXIT trap)
exit $WS_EXIT
