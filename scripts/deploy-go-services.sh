#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT="staging"
TARGET="all"
VM=""
REMOTE_BUILD="/tmp/chiridion-build"
LOCAL_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

usage() {
  echo "Usage: $0 [--env prod|staging] [--host ssh-target] [sandbox-host|data-proxy|all]"
  echo ""
  echo "Deploy Go services to the Azure sandbox-host VM."
  echo ""
  echo "Options:"
  echo "  --env ENV       Deploy target environment. Defaults to staging."
  echo "  --host HOST     Override SSH target. Also available via SANDBOX_GO_DEPLOY_HOST."
  echo ""
  echo "Targets:"
  echo "  sandbox-host  - Deploy sandbox host only"
  echo "  data-proxy    - Deploy data proxy only"
  echo "  all           - Deploy both (default)"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --env)
      if [[ $# -lt 2 ]]; then
        usage
      fi
      ENVIRONMENT="${2:-}"
      shift 2
      ;;
    --host)
      if [[ $# -lt 2 ]]; then
        usage
      fi
      VM="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      ;;
    sandbox-host|data-proxy|all)
      TARGET="$1"
      shift
      ;;
    *)
      usage
      ;;
  esac
done

if [[ -z "$ENVIRONMENT" ]]; then
  usage
fi

case "$ENVIRONMENT" in
  prod)
    VM="${VM:-${SANDBOX_GO_DEPLOY_HOST:-chiridion-vm}}"
    ;;
  staging)
    VM="${VM:-${SANDBOX_GO_DEPLOY_HOST:-chiridion-vm-staging}}"
    ;;
  *)
    echo "Unknown environment: $ENVIRONMENT"
    usage
    ;;
esac

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

restart_service() {
  local svc="$1"
  local unit="$2"

  if [[ "$svc" == "sandbox-host" ]]; then
    echo "==> Draining $unit before restart..."
    ssh "$VM" "set -euo pipefail
      install_graceful_reload_unit() {
        sudo mkdir -p /etc/systemd/system/${unit}.service.d
        printf '%s\n' '[Service]' 'KillMode=process' 'TimeoutStopSec=1800' | sudo tee /etc/systemd/system/${unit}.service.d/graceful-reload.conf >/dev/null
        sudo systemctl daemon-reload
      }
      cleanup() {
        curl -fsS -X DELETE --max-time 5 'http://127.0.0.1/internal/admin/drain' >/dev/null 2>&1 || true
      }
      if curl -fsS --max-time 5 'http://127.0.0.1/internal/admin/drain' >/dev/null; then
        install_graceful_reload_unit
        trap cleanup ERR
        curl -fsS -X POST --max-time 1810 'http://127.0.0.1/internal/admin/drain?wait=1&timeout=1800'
        sudo systemctl restart $unit
        trap - ERR
      else
        echo 'Drain endpoint unavailable; falling back to normal restart for this deploy.'
        sudo systemctl restart $unit
        install_graceful_reload_unit
      fi
      "
    return
  fi

  echo "==> Restarting $unit..."
  ssh "$VM" "sudo systemctl restart $unit"
}

if [[ "$TARGET" != "all" && "$TARGET" != "sandbox-host" && "$TARGET" != "data-proxy" ]]; then
  usage
fi

# Build target list
if [[ "$TARGET" == "all" ]]; then
  TARGETS=(sandbox-host data-proxy)
else
  TARGETS=("$TARGET")
fi

echo "==> Deploying Go services to $ENVIRONMENT ($VM)..."
echo "==> Syncing Go source to $VM..."
rsync -az --delete \
  "$LOCAL_ROOT/services/sandbox-host/" \
  "$VM:$REMOTE_BUILD/services/sandbox-host/"

if [[ " ${TARGETS[*]} " == *" sandbox-host "* ]]; then
  echo "==> Syncing sandbox skills to $VM..."
  ssh "$VM" "mkdir -p '$REMOTE_BUILD/sandbox/skills'"
  rsync -az --delete \
    "$LOCAL_ROOT/sandbox/skills/" \
    "$VM:$REMOTE_BUILD/sandbox/skills/"
  echo "==> Installing host Pi on $VM..."
  ssh "$VM" "HOST_PI_EXTENSION_SOURCE='$REMOTE_BUILD/services/sandbox-host/pi/container-tools.ts' HOST_PI_SKILLS_SOURCE='$REMOTE_BUILD/sandbox/skills' bash -s" < "$LOCAL_ROOT/scripts/install-host-pi.sh"
fi

for svc in "${TARGETS[@]}"; do
  pkg="$(service_pkg "$svc")"
  bin="$(service_bin "$svc")"
  unit="$(service_unit "$svc")"

  echo "==> Building $svc..."
  ssh "$VM" "cd $REMOTE_BUILD/services/sandbox-host && sudo go build -o $bin $pkg"

  restart_service "$svc" "$unit"

  echo "==> Status:"
  ssh "$VM" "sudo systemctl status $unit --no-pager -l" || true
  echo ""
done

echo "==> Done."
