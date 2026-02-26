#!/usr/bin/env bash
set -euo pipefail

VM="chiridion-vm"
REMOTE_BUILD="/tmp/chiridion-build"
LOCAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 [sandbox-host|data-proxy|all]"
  echo ""
  echo "Deploy Go services to the Azure VM."
  echo "  sandbox-host  - Deploy sandbox host only"
  echo "  data-proxy    - Deploy data proxy only"
  echo "  all           - Deploy both (default)"
  exit 1
}

# Resolve service config by name
service_pkg() {
  case "$1" in
    sandbox-host) echo "./cmd/sandbox-host/" ;;
    data-proxy)   echo "./cmd/data-proxy/" ;;
  esac
}
service_bin() {
  case "$1" in
    sandbox-host) echo "/usr/local/bin/chiridion-sandbox-host" ;;
    data-proxy)   echo "/usr/local/bin/chiridion-data-proxy" ;;
  esac
}
service_unit() {
  case "$1" in
    sandbox-host) echo "chiridion-sandbox-host" ;;
    data-proxy)   echo "chiridion-data-proxy" ;;
  esac
}

TARGET="${1:-all}"

if [[ "$TARGET" != "all" && "$TARGET" != "sandbox-host" && "$TARGET" != "data-proxy" ]]; then
  usage
fi

# Build target list
if [[ "$TARGET" == "all" ]]; then
  TARGETS=(sandbox-host data-proxy)
else
  TARGETS=("$TARGET")
fi

echo "==> Syncing Go source to $VM..."
rsync -az --delete \
  "$LOCAL_ROOT/services/sandbox-host/" \
  "$VM:$REMOTE_BUILD/services/sandbox-host/"

for svc in "${TARGETS[@]}"; do
  pkg="$(service_pkg "$svc")"
  bin="$(service_bin "$svc")"
  unit="$(service_unit "$svc")"

  echo "==> Building $svc..."
  ssh "$VM" "cd $REMOTE_BUILD/services/sandbox-host && sudo go build -o $bin $pkg"

  echo "==> Restarting $unit..."
  ssh "$VM" "sudo systemctl restart $unit"

  echo "==> Status:"
  ssh "$VM" "sudo systemctl status $unit --no-pager -l" || true
  echo ""
done

echo "==> Done."
