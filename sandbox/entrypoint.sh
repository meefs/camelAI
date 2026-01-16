#!/bin/sh
# Container entrypoint - mounts JuiceFS (R2 + SQLite) and starts services.
# Environment variables are passed at container start time via @cloudflare/containers.
#
# Ports:
#   8080 - ws-server (Claude SDK) - runs as claude user
#   9000 - control-plane (exec/fs) - runs as claude user
#
# Version: 2026-01-16-v3
set -eu

# Debug logging helper
debug_log() {
  echo "[entrypoint:DEBUG] $*" >&2
}

debug_permissions() {
  local path="$1"
  local label="${2:-}"
  debug_log "=== Permissions for ${path} ${label} ==="
  if [ -e "$path" ]; then
    debug_log "  exists: yes"
    debug_log "  ls -la: $(ls -la "$path" 2>&1 || echo 'FAILED')"
    debug_log "  ls -ld: $(ls -ld "$path" 2>&1 || echo 'FAILED')"
    debug_log "  stat: $(stat "$path" 2>&1 || echo 'FAILED')"
    if [ -d "$path" ]; then
      debug_log "  is_directory: yes"
      debug_log "  contents: $(ls -la "$path" 2>&1 | head -20 || echo 'FAILED')"
    fi
  else
    debug_log "  exists: no"
  fi
  debug_log "=== End permissions for ${path} ==="
}

debug_user_info() {
  debug_log "=== User info ==="
  debug_log "  whoami: $(whoami 2>&1 || echo 'FAILED')"
  debug_log "  id: $(id 2>&1 || echo 'FAILED')"
  debug_log "  id claude: $(id claude 2>&1 || echo 'FAILED')"
  debug_log "  CLAUDE_UID: $(id -u claude 2>&1 || echo 'FAILED')"
  debug_log "  CLAUDE_GID: $(id -g claude 2>&1 || echo 'FAILED')"
  debug_log "  /etc/passwd claude: $(grep claude /etc/passwd 2>&1 || echo 'not found')"
  debug_log "  /etc/group claude: $(grep claude /etc/group 2>&1 || echo 'not found')"
  debug_log "=== End user info ==="
}

debug_mount_info() {
  debug_log "=== Mount info ==="
  debug_log "  /proc/mounts relevant:"
  grep -E "(juicefs|fuse|$TARGET_DIR)" /proc/mounts 2>&1 || debug_log "    (no relevant mounts)"
  debug_log "  df -h $TARGET_DIR: $(df -h "$TARGET_DIR" 2>&1 || echo 'FAILED')"
  debug_log "  mount | grep $TARGET_DIR: $(mount | grep "$TARGET_DIR" 2>&1 || echo 'none')"
  debug_log "=== End mount info ==="
}

test_write_as_claude() {
  local test_path="$1"
  local test_file="$test_path/.write-test-$$"
  debug_log "=== Testing write as claude to ${test_path} ==="

  # Test as root first
  debug_log "  Testing write as root..."
  if echo "root-test" > "$test_file.root" 2>&1; then
    debug_log "    root write: SUCCESS"
    ls -la "$test_file.root" 2>&1 | while read line; do debug_log "      $line"; done
    rm -f "$test_file.root" 2>/dev/null || debug_log "    root cleanup failed"
  else
    debug_log "    root write: FAILED"
  fi

  # Test as claude
  debug_log "  Testing write as claude..."
  if su -s /bin/sh claude -c "echo 'claude-test' > '$test_file.claude'" 2>&1; then
    debug_log "    claude write: SUCCESS"
    ls -la "$test_file.claude" 2>&1 | while read line; do debug_log "      $line"; done
    rm -f "$test_file.claude" 2>/dev/null || debug_log "    claude cleanup failed"
  else
    debug_log "    claude write: FAILED"
  fi

  # Test mkdir as claude
  local test_dir="$test_path/.mkdir-test-$$"
  debug_log "  Testing mkdir as claude..."
  if su -s /bin/sh claude -c "mkdir -p '$test_dir'" 2>&1; then
    debug_log "    claude mkdir: SUCCESS"
    ls -ld "$test_dir" 2>&1 | while read line; do debug_log "      $line"; done
    rmdir "$test_dir" 2>/dev/null || debug_log "    mkdir cleanup failed"
  else
    debug_log "    claude mkdir: FAILED"
  fi

  debug_log "=== End write test ==="
}

echo "[entrypoint] Starting container initialization..." >&2
START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
echo "[entrypoint] ORG_ID=${ORG_ID:-unset}" >&2
echo "[entrypoint] WORKSPACE_ID=${WORKSPACE_ID:-unset}" >&2
echo "[entrypoint] R2_BUCKET_NAME=${R2_BUCKET_NAME:-unset}" >&2

debug_log "Initial environment and user state:"
debug_user_info

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

  debug_log "Creating directories: TARGET_DIR=$TARGET_DIR, JUICEFS_META_DIR=$JUICEFS_META_DIR, JUICEFS_CACHE_DIR=$JUICEFS_CACHE_DIR"
  mkdir -p "$TARGET_DIR" "$JUICEFS_META_DIR" "$JUICEFS_CACHE_DIR"

  debug_log "Permissions BEFORE chown:"
  debug_permissions "$TARGET_DIR" "(TARGET_DIR)"
  debug_permissions "$JUICEFS_META_DIR" "(JUICEFS_META_DIR)"
  debug_permissions "$JUICEFS_CACHE_DIR" "(JUICEFS_CACHE_DIR)"

  chown -R claude:claude "$JUICEFS_CACHE_DIR" 2>/dev/null || true
  debug_log "Permissions AFTER chown on cache dir:"
  debug_permissions "$JUICEFS_CACHE_DIR" "(JUICEFS_CACHE_DIR after chown)"

  debug_log "Checking /etc/fuse.conf:"
  if [ -f /etc/fuse.conf ]; then
    debug_log "  /etc/fuse.conf contents: $(cat /etc/fuse.conf 2>&1)"
  else
    debug_log "  /etc/fuse.conf does not exist"
  fi

  if [ -w /etc/fuse.conf ] && ! grep -q '^user_allow_other' /etc/fuse.conf; then
    echo "user_allow_other" >> /etc/fuse.conf
    debug_log "  Added user_allow_other to /etc/fuse.conf"
  fi

  debug_log "/etc/fuse.conf after update: $(cat /etc/fuse.conf 2>&1 || echo 'not readable')"

  echo "[entrypoint] Restoring JuiceFS metadata (if present)..." >&2
  META_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  debug_log "Downloading metadata to: $JFS_META_FILE"
  DOWNLOAD_OUTPUT=$(node /app/r2-meta.mjs download "$JFS_META_FILE" 2>&1) || true
  debug_log "Metadata download output: $DOWNLOAD_OUTPUT"
  META_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
  echo "[entrypoint] Metadata restore done (ms: $((META_END_TS - META_START_TS)))" >&2

  debug_log "Metadata file after download:"
  if [ -f "$JFS_META_FILE" ]; then
    debug_log "  exists: yes"
    debug_log "  size: $(ls -la "$JFS_META_FILE" 2>&1)"
    debug_log "  owner: $(stat -c '%U:%G' "$JFS_META_FILE" 2>&1 || stat -f '%Su:%Sg' "$JFS_META_FILE" 2>&1 || echo 'unknown')"
  else
    debug_log "  exists: no"
  fi

  debug_log "Changing ownership of JUICEFS_META_DIR to claude:claude..."
  chown -R claude:claude "$JUICEFS_META_DIR" 2>/dev/null || true
  debug_permissions "$JUICEFS_META_DIR" "(after chown)"

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
    debug_log "=== JuiceFS format configuration ==="
    debug_log "  VOLUME_NAME: $VOLUME_NAME"
    debug_log "  JFS_BUCKET_URL: $JFS_BUCKET_URL"
    debug_log "  JFS_META_URL: $JFS_META_URL"
    debug_log "  Running format as claude user..."
    debug_log "=== End format configuration ==="

    FORMAT_OUTPUT=$(su -s /bin/sh claude -c "juicefs format \
      --storage s3 \
      --bucket \"$JFS_BUCKET_URL\" \
      --access-key \"$AWS_ACCESS_KEY_ID\" \
      --secret-key \"$AWS_SECRET_ACCESS_KEY\" \
      ${AWS_SESSION_TOKEN:+--session-token \"$AWS_SESSION_TOKEN\"} \
      \"$JFS_META_URL\" \
      \"$VOLUME_NAME\"" 2>&1) && FORMAT_SUCCESS=1 || FORMAT_SUCCESS=0

    debug_log "Format output: $FORMAT_OUTPUT"
    debug_log "Format success: $FORMAT_SUCCESS"

    if [ "$FORMAT_SUCCESS" = "1" ]; then
      debug_log "Format succeeded, uploading metadata..."
      upload_juicefs_meta
    else
      debug_log "Format FAILED"
    fi
  else
    debug_log "Metadata file exists, skipping format: $JFS_META_FILE"
    debug_log "Metadata file size: $(ls -la "$JFS_META_FILE" 2>&1)"
  fi

  JFS_READONLY_FLAG=""
  if [ "${R2_MOUNT_READONLY:-}" = "1" ] || [ "${R2_MOUNT_READONLY:-}" = "true" ]; then
    JFS_READONLY_FLAG="-r"
  fi

  try_mount_juicefs() {
    echo "[entrypoint] Mounting JuiceFS at ${TARGET_DIR}..." >&2
    MOUNT_START_TS="$(date +%s%3N 2>/dev/null || date +%s)"
    # Get claude's UID/GID while running as root (before su)
    CLAUDE_UID="$(id -u claude)"
    CLAUDE_GID="$(id -g claude)"

    debug_log "=== JuiceFS mount configuration ==="
    debug_log "  JFS_META_URL: $JFS_META_URL"
    debug_log "  TARGET_DIR: $TARGET_DIR"
    debug_log "  JUICEFS_CACHE_DIR: $JUICEFS_CACHE_DIR"
    debug_log "  JUICEFS_UPLOAD_DELAY: $JUICEFS_UPLOAD_DELAY"
    debug_log "  CLAUDE_UID: $CLAUDE_UID"
    debug_log "  CLAUDE_GID: $CLAUDE_GID"
    debug_log "  JFS_READONLY_FLAG: '${JFS_READONLY_FLAG:-empty}'"
    debug_log "  FUSE options: allow_other,user_id=$CLAUDE_UID,group_id=$CLAUDE_GID"
    debug_log "=== End mount configuration ==="

    debug_log "TARGET_DIR permissions BEFORE mount:"
    debug_permissions "$TARGET_DIR" "(before mount)"

    debug_log "Running juicefs mount command as claude user..."
    MOUNT_OUTPUT=$(su -s /bin/sh claude -c "juicefs mount \"$JFS_META_URL\" \"$TARGET_DIR\" \
      --backup-meta 0 \
      --cache-dir \"$JUICEFS_CACHE_DIR\" \
      --upload-delay \"$JUICEFS_UPLOAD_DELAY\" \
      --prefix-internal \
      -o allow_other,user_id=$CLAUDE_UID,group_id=$CLAUDE_GID \
      --writeback \
      $JFS_READONLY_FLAG \
      -d" 2>&1) || true
    debug_log "Mount command output: $MOUNT_OUTPUT"

    MOUNT_END_TS="$(date +%s%3N 2>/dev/null || date +%s)"
    echo "[entrypoint] Mount command issued (ms: $((MOUNT_END_TS - MOUNT_START_TS)))" >&2

    for i in 1 2 3 4 5 6 7 8 9 10; do
      if grep -q " $TARGET_DIR " /proc/mounts; then
        echo "[entrypoint] JuiceFS mounted." >&2
        debug_log "Mount successful on attempt $i"

        debug_log "TARGET_DIR permissions AFTER mount:"
        debug_permissions "$TARGET_DIR" "(after mount)"
        debug_mount_info

        debug_log "Testing write capability on mounted filesystem:"
        test_write_as_claude "$TARGET_DIR"

        return 0
      fi
      debug_log "Waiting for mount... attempt $i"
      sleep 0.2
    done

    debug_log "Mount FAILED after 10 attempts"
    debug_mount_info
    return 1
  }

  if try_mount_juicefs; then
    return 0
  fi

  if [ -f /var/log/juicefs.log ]; then
    echo "[entrypoint] JuiceFS log (tail):" >&2
    tail -n 200 /var/log/juicefs.log >&2 || true
  fi

  # Check for juicefs logs in other locations
  debug_log "Checking for additional JuiceFS logs..."
  for logfile in /var/log/juicefs*.log ~/.juicefs/juicefs.log /tmp/juicefs*.log; do
    if [ -f "$logfile" ]; then
      debug_log "Found log: $logfile"
      debug_log "Contents (last 50 lines):"
      tail -n 50 "$logfile" 2>&1 | while read line; do debug_log "  $line"; done
    fi
  done

  # Check dmesg for FUSE errors
  debug_log "Checking dmesg for FUSE errors..."
  dmesg 2>/dev/null | grep -i -E "(fuse|juicefs)" | tail -20 | while read line; do debug_log "  dmesg: $line"; done || true

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

  debug_log "=== goofys mount configuration ==="
  debug_log "  R2_ENDPOINT: $R2_ENDPOINT"
  debug_log "  R2_BASE: $R2_BASE"
  debug_log "  claude UID: $(id -u claude)"
  debug_log "  claude GID: $(id -g claude)"
  debug_log "=== End goofys configuration ==="

  # Create mount directories
  mkdir -p /mnt/user-uploads /mnt/user-outputs

  # Mount user-uploads (files uploaded by user via web UI)
  debug_log "Mounting goofys user-uploads..."
  GOOFYS_UPLOADS_OUTPUT=$(goofys --endpoint "$R2_ENDPOINT" -o allow_other --uid "$(id -u claude)" --gid "$(id -g claude)" \
      "${R2_BUCKET_NAME}:${R2_BASE}user-uploads" /mnt/user-uploads 2>&1) && GOOFYS_UPLOADS_SUCCESS=1 || GOOFYS_UPLOADS_SUCCESS=0
  debug_log "goofys user-uploads output: $GOOFYS_UPLOADS_OUTPUT"
  if [ "$GOOFYS_UPLOADS_SUCCESS" = "1" ]; then
    echo "[entrypoint] Mounted /mnt/user-uploads" >&2
    debug_permissions "/mnt/user-uploads" "(after goofys mount)"
  else
    echo "[entrypoint] WARNING: Failed to mount /mnt/user-uploads" >&2
  fi

  # Mount user-outputs (files created for user to download)
  debug_log "Mounting goofys user-outputs..."
  GOOFYS_OUTPUTS_OUTPUT=$(goofys --endpoint "$R2_ENDPOINT" -o allow_other --uid "$(id -u claude)" --gid "$(id -g claude)" \
      "${R2_BUCKET_NAME}:${R2_BASE}user-outputs" /mnt/user-outputs 2>&1) && GOOFYS_OUTPUTS_SUCCESS=1 || GOOFYS_OUTPUTS_SUCCESS=0
  debug_log "goofys user-outputs output: $GOOFYS_OUTPUTS_OUTPUT"
  if [ "$GOOFYS_OUTPUTS_SUCCESS" = "1" ]; then
    echo "[entrypoint] Mounted /mnt/user-outputs" >&2
    debug_permissions "/mnt/user-outputs" "(after goofys mount)"
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

debug_log "=== Skills installation debug ==="
debug_log "TARGET_DIR: $TARGET_DIR"
debug_log "Skills source: /app/skills/"

# Show what we're copying
debug_log "Contents of /app/skills/:"
ls -laR /app/skills/ 2>&1 | head -50 | while read line; do debug_log "  $line"; done

# Check current state of .claude directory
debug_log "Checking .claude directory state:"
debug_permissions "$TARGET_DIR/.claude" "(before skills install)"

# Check if TARGET_DIR is writable
debug_log "Testing if TARGET_DIR is writable as claude:"
test_write_as_claude "$TARGET_DIR"

# Try to create .claude directory first, with verbose output
debug_log "Step 1: Creating $TARGET_DIR/.claude directory..."
MKDIR_OUTPUT=$(su -s /bin/sh claude -c "mkdir -p \"$TARGET_DIR/.claude\" && echo 'mkdir success'" 2>&1) || true
debug_log "mkdir .claude output: $MKDIR_OUTPUT"
debug_permissions "$TARGET_DIR/.claude" "(after mkdir .claude)"

# Try to create .claude/skills directory
debug_log "Step 2: Creating $TARGET_DIR/.claude/skills directory..."
MKDIR_SKILLS_OUTPUT=$(su -s /bin/sh claude -c "mkdir -p \"$TARGET_DIR/.claude/skills\" && echo 'mkdir skills success'" 2>&1) || true
debug_log "mkdir skills output: $MKDIR_SKILLS_OUTPUT"
debug_permissions "$TARGET_DIR/.claude/skills" "(after mkdir skills)"

# Try to copy skills
debug_log "Step 3: Copying skills..."
CP_OUTPUT=$(su -s /bin/sh claude -c "cp -rv /app/skills/. \"$TARGET_DIR/.claude/skills/\"" 2>&1) || true
debug_log "cp output (first 50 lines): $(echo "$CP_OUTPUT" | head -50)"

# Verify the copy
debug_log "Step 4: Verifying skills installation..."
debug_permissions "$TARGET_DIR/.claude/skills" "(after copy)"
if [ -d "$TARGET_DIR/.claude/skills" ]; then
  debug_log "Skills directory contents:"
  ls -laR "$TARGET_DIR/.claude/skills" 2>&1 | head -30 | while read line; do debug_log "  $line"; done
else
  debug_log "ERROR: Skills directory does not exist after copy!"
fi

debug_log "=== End skills installation debug ==="

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

debug_log "=== Final state summary ==="
debug_log "Target directory state:"
debug_permissions "$TARGET_DIR" "(final)"
debug_log ".claude directory state:"
debug_permissions "$TARGET_DIR/.claude" "(final)"
debug_log ".claude/skills directory state:"
debug_permissions "$TARGET_DIR/.claude/skills" "(final)"
debug_mount_info
debug_log "=== End final state summary ==="

# Wait for ws-server - when it exits, the cleanup trap will run
wait "$WS_PID"
WS_EXIT=$?
echo "[entrypoint] ws-server exited with code: $WS_EXIT" >&2

# Exit with ws-server's exit code (cleanup runs via EXIT trap)
exit $WS_EXIT
