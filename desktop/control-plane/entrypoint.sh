#!/bin/sh
set -eu

SHARED_ROOT="${DESKTOP_RUNTIME_SHARED_DIR:-/mnt/camelai-shared}"
ENV_FILE="$SHARED_ROOT/runtime/control-plane-env.sh"

if [ -f "$ENV_FILE" ]; then
  set -a
  . "$ENV_FILE"
  set +a
fi

HOME_DIR="${HOME:-$SHARED_ROOT/runtime/container-home}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}"

export HOME="$HOME_DIR"
export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"

mkdir -p "$HOME_DIR" "$CLAUDE_DIR" "$SHARED_ROOT/logs" "$SHARED_ROOT/runtime" "$SHARED_ROOT/workspace"
echo starting-control-plane > "$SHARED_ROOT/runtime/status.txt"
chmod 666 "$SHARED_ROOT/runtime/status.txt" || true

cd "$SHARED_ROOT/workspace"
exec gosu node:node node /opt/camelai-desktop-guest/control-plane.mjs
