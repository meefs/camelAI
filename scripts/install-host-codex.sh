#!/usr/bin/env bash
set -euo pipefail

INSTALL_DIR="${HOST_CODEX_INSTALL_DIR:-/opt/chiridion-host-codex}"
INSTALL_PATH="${HOST_CODEX_INSTALL_PATH:-/usr/local/bin/chiridion-host-codex}"

arch="$(uname -m)"
case "$arch" in
  x86_64)
    npm_platform_suffix="linux-x64"
    vendor_dir="x86_64-unknown-linux-musl"
    ;;
  aarch64|arm64)
    npm_platform_suffix="linux-arm64"
    vendor_dir="aarch64-unknown-linux-musl"
    ;;
  *)
    echo "Unsupported architecture: $arch" >&2
    exit 1
    ;;
esac

latest_version="$(python3 - <<'PY'
import json
import urllib.request

with urllib.request.urlopen('https://registry.npmjs.org/@openai%2fcodex/latest') as response:
    data = json.load(response)

version = str(data.get('version', '')).strip()
if not version:
    raise SystemExit('Unable to determine latest @openai/codex version')

print(version)
PY
)"

package_version="${latest_version}-${npm_platform_suffix}"
tarball_url="https://registry.npmjs.org/@openai/codex/-/codex-${package_version}.tgz"

tmp_dir="$(mktemp -d)"
cleanup() {
  rm -rf "$tmp_dir"
}
trap cleanup EXIT

curl -fsSL "$tarball_url" -o "$tmp_dir/codex.tgz"
tar -xzf "$tmp_dir/codex.tgz" -C "$tmp_dir"

binary_path="$tmp_dir/package/vendor/$vendor_dir/codex/codex"
if [[ ! -x "$binary_path" ]]; then
  echo "Codex binary missing from tarball: $binary_path" >&2
  exit 1
fi

sudo mkdir -p "$INSTALL_DIR"
sudo install -m 0755 "$binary_path" "$INSTALL_DIR/codex"
sudo ln -sf "$INSTALL_DIR/codex" "$INSTALL_PATH"

"$INSTALL_PATH" --version
