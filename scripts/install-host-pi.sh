#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOST_PI_INSTALL_DIR:-/opt/chiridion-host-pi}"
INSTALL_PATH="${HOST_PI_INSTALL_PATH:-/usr/local/bin/chiridion-host-pi}"
EXTENSION_SOURCE="${HOST_PI_EXTENSION_SOURCE:-}"
SKILLS_SOURCE="${HOST_PI_SKILLS_SOURCE:-}"
PI_CODING_AGENT_VERSION="${PI_CODING_AGENT_VERSION:-0.73.0}"
TYPEBOX_VERSION="${TYPEBOX_VERSION:-1.1.37}"

ensure_npm() {
  if command -v npm >/dev/null 2>&1; then
    return
  fi

  echo "==> npm not found; installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x \
    | sudo -E env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a bash - >/dev/null
  sudo env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a apt-get install -y -qq nodejs >/dev/null
}

ensure_npm

sudo mkdir -p "$INSTALL_DIR/extensions"
tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

cat > "$tmp_dir/package.json" <<JSON
{
  "name": "chiridion-host-pi",
  "private": true,
  "type": "module",
  "dependencies": {
    "@mariozechner/pi-coding-agent": "$PI_CODING_AGENT_VERSION",
    "typebox": "$TYPEBOX_VERSION"
  }
}
JSON

echo "==> Installing host Pi package into $INSTALL_DIR..."
sudo cp "$tmp_dir/package.json" "$INSTALL_DIR/package.json"
sudo npm install --prefix "$INSTALL_DIR" --omit=dev --loglevel=warn

if [[ -n "$EXTENSION_SOURCE" && -f "$EXTENSION_SOURCE" ]]; then
  sudo install -m 0644 "$EXTENSION_SOURCE" "$INSTALL_DIR/extensions/container-tools.ts"
fi

if [[ -n "$SKILLS_SOURCE" && -d "$SKILLS_SOURCE" ]]; then
  sudo rm -rf "$INSTALL_DIR/skills"
  sudo mkdir -p "$INSTALL_DIR/skills"
  sudo cp -a "$SKILLS_SOURCE/." "$INSTALL_DIR/skills/"
  sudo find "$INSTALL_DIR/skills" -type d -exec chmod 0755 {} +
  sudo find "$INSTALL_DIR/skills" -type f -exec chmod 0644 {} +
fi

sudo ln -sf "$INSTALL_DIR/node_modules/.bin/pi" "$INSTALL_PATH"
"$INSTALL_PATH" --version
