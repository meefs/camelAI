#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOCKET="/tmp/docker-fuse-proxy.sock"
VITE_PORT="${VITE_DEV_PORT:-3001}"

# Check if docker proxy is accepting connections
is_proxy_running() {
  node -e "require('net').createConnection('$SOCKET').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))" 2>/dev/null
}

# Start docker proxy in background if not running
if ! is_proxy_running; then
  echo "[dev] starting docker proxy..."
  nohup node "$SCRIPT_DIR/docker-api-proxy.mjs" >/dev/null 2>&1 &

  # Wait for it to be ready
  for i in {1..50}; do
    if is_proxy_running; then
      break
    fi
    sleep 0.1
  done

  if ! is_proxy_running; then
    echo "[dev] docker proxy failed to start"
    exit 1
  fi
fi

echo "[dev] docker proxy ready"
echo "[dev] react-router dev (HMR) -> http://localhost:$VITE_PORT"

# Run react-router dev with DOCKER_HOST pointing to our proxy
# Use dev config which includes auxiliary workers (proxy)
DOCKER_HOST="unix://$SOCKET" exec react-router dev --port "$VITE_PORT" --config vite.config.dev.ts
