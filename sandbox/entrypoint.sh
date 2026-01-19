#!/bin/sh
# Container entrypoint - handles R2 sync and starts services.
# Environment variables are passed at container start time via @cloudflare/containers.
#
# Ports:
#   8080 - ws-server (Claude SDK) - runs as claude user
#   9000 - control-plane (exec/fs) - runs as claude user
#
# Version: 2026-01-18-v1
set -eu

echo "[entrypoint] Starting container initialization..." >&2
echo "[entrypoint] ORG_ID=${ORG_ID:-unset}" >&2
echo "[entrypoint] WORKSPACE_ID=${WORKSPACE_ID:-unset}" >&2
echo "[entrypoint] R2_BUCKET_NAME=${R2_BUCKET_NAME:-unset}" >&2

TARGET_DIR="${R2_MOUNT_DIR:-/home/claude}"
FIRST_RUN_MARKER="/tmp/.r2-synced"

# Track PIDs for cleanup (Verdaccio managed by pm2)
WS_PID=""
CONTROL_PID=""

# Check if R2 is configured
has_r2_config() {
  [ -n "${R2_BUCKET_NAME:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && \
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ]
}

# Cleanup function for shutdown (runs on EXIT, which fires for all termination paths)
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

  # Stop Verdaccio via pm2
  echo "[entrypoint] Stopping Verdaccio (pm2)..." >&2
  pm2 stop verdaccio 2>/dev/null || true

  # Unmount R2 goofys mounts
  fusermount -u /mnt/user-uploads 2>/dev/null || true
  fusermount -u /mnt/user-outputs 2>/dev/null || true

  # Upload workspace to R2
  if has_r2_config && [ "${R2_MOUNT_READONLY:-}" != "1" ] && [ "${R2_MOUNT_READONLY:-}" != "true" ]; then
    echo "[entrypoint] Uploading snapshot to R2..." >&2
    node /app/sync.mjs upload "$TARGET_DIR" || true
    echo "[entrypoint] Upload complete." >&2
  fi

  echo "[entrypoint] Shutdown complete." >&2
}

# Trap EXIT for cleanup, and TERM/INT to convert signals into normal exits.
# In dash (Debian's /bin/sh), EXIT trap doesn't fire on untrapped signals,
# so we must trap TERM/INT to ensure cleanup runs on container shutdown.
trap cleanup EXIT
trap 'exit 0' TERM INT

# Start Verdaccio npm registry via pm2 (async - don't wait, it'll be ready by the time it's needed)
# This runs in parallel with R2 download and other startup tasks
echo "[entrypoint] Starting Verdaccio npm registry (async)..." >&2
pm2 start verdaccio --name verdaccio -- --config /verdaccio/config.yaml >/dev/null 2>&1

# R2 download on first run (if configured)
if has_r2_config; then
  echo "[entrypoint] R2 configured, checking for snapshot..." >&2

  if [ ! -f "$FIRST_RUN_MARKER" ]; then
    echo "[entrypoint] Downloading R2 snapshot..." >&2
    if node /app/sync.mjs download "$TARGET_DIR"; then
      touch "$FIRST_RUN_MARKER"
      echo "[entrypoint] R2 download complete." >&2
    else
      echo "[entrypoint] FATAL: R2 sync failed! Container cannot start without workspace data." >&2
      echo "[entrypoint] Note: 404 (no backup yet) is handled gracefully - this is a real error." >&2
      exit 1
    fi
  else
    echo "[entrypoint] R2 snapshot already downloaded (marker exists)." >&2
  fi

else
  echo "[entrypoint] No R2 credentials, running without sync." >&2
fi

# Mount R2 paths via goofys for file sharing with user
if has_r2_config; then
  echo "[entrypoint] Mounting R2 file sharing directories..." >&2
  R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"
  R2_BASE="${R2_PREFIX:-${ORG_ID}/${WORKSPACE_ID}/}"

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

# Ensure workspace directory exists and is owned by claude
mkdir -p "$TARGET_DIR"
chown -R claude:claude "$TARGET_DIR"

# Install skills to claude's config directory
echo "[entrypoint] Installing skills..." >&2
mkdir -p "$TARGET_DIR/.claude/skills"
cp -r /app/skills/. "$TARGET_DIR/.claude/skills/"
chown -R claude:claude "$TARGET_DIR/.claude"

# Write env vars to a file that claude user can source
cat > /tmp/ws-env.sh << ENVEOF
export ANTHROPIC_API_KEY='${ANTHROPIC_API_KEY:-}'
export ORG_ID='${ORG_ID:-}'
export WORKSPACE_ID='${WORKSPACE_ID:-}'
export R2_BUCKET_NAME='${R2_BUCKET_NAME:-}'
export R2_ACCOUNT_ID='${R2_ACCOUNT_ID:-}'
export R2_MOUNT_DIR='${R2_MOUNT_DIR:-}'
export R2_PREFIX='${R2_PREFIX:-}'
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

# Wait for ws-server - when it exits, the cleanup trap will run
wait "$WS_PID"
WS_EXIT=$?
echo "[entrypoint] ws-server exited with code: $WS_EXIT" >&2

# Exit with ws-server's exit code (cleanup runs via EXIT trap)
exit $WS_EXIT
