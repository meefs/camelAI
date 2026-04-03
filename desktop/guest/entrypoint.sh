#!/bin/sh
set -eu

SHARED_ROOT=/mnt/camelai-shared
AUTH_ROOT="$SHARED_ROOT/auth/home"
HOME_DIR="${HOME:-$SHARED_ROOT/runtime/container-home}"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME_DIR/.claude}"
export HOME="$HOME_DIR"
export CLAUDE_CONFIG_DIR="$CLAUDE_DIR"

mkdir -p "$HOME_DIR" "$CLAUDE_DIR" "$SHARED_ROOT/logs" "$SHARED_ROOT/workspace"

if [ -d "$AUTH_ROOT/.claude" ]; then
  cp -R "$AUTH_ROOT/.claude/." "$CLAUDE_DIR/"
fi

if [ -f "$AUTH_ROOT/.claude.json" ]; then
  cp "$AUTH_ROOT/.claude.json" "$HOME_DIR/.claude.json"
fi

cd "$SHARED_ROOT/workspace"
exec gosu node node /opt/camelai-desktop-guest/control-plane.mjs
