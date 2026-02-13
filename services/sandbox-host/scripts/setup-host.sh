#!/usr/bin/env bash
#
# Azure VM provisioning script for Chiridion sandbox host.
# Sets up: NVMe RAID0 (cache), JuiceFS (durable canonical via Azure Blob + PostgreSQL),
# overlayfs (per-workspace tiered mounts), Docker + gVisor, Bun.
#
# Storage layout:
#   /mnt/nvme           - NVMe RAID0 (fast ephemeral, overlay upper layers)
#   /mnt/juicefs        - JuiceFS (durable canonical, overlay lower layers)
#   /mnt/workspaces     - Per-workspace overlayfs merged mount points
#   /mnt/nvme/.docker   - Docker data root
#   /mnt/nvme/jfs-cache - JuiceFS local cache on NVMe
#
# Required environment variables (from /etc/chiridion/storage.env):
#   STORAGE_ACCOUNT   - Azure Blob storage account name
#   STORAGE_KEY       - Azure Blob storage account key
#   JUICEFS_CONTAINER - Blob container for JuiceFS data chunks
#   PG_HOST           - Azure PostgreSQL Flexible Server FQDN
#   PG_PASSWORD       - PostgreSQL admin password
#
# Usage: sudo bash setup-host.sh
#
set -euo pipefail

echo "=== Chiridion Sandbox Host Setup ==="

# ─── Config ──────────────────────────────────────────────────
NVME_DIR="/mnt/nvme"
JUICEFS_DIR="/mnt/juicefs"
WORKSPACES_DIR="/mnt/workspaces"

# Container image — use ACR if configured, otherwise local
if [ -n "${ACR_LOGIN_SERVER:-}" ]; then
  SANDBOX_IMAGE="${ACR_LOGIN_SERVER}/chiridion-sandbox:latest"
else
  SANDBOX_IMAGE="chiridion-sandbox:latest"
fi

# ─── 1. NVMe RAID0 ──────────────────────────────────────────
echo "[1/9] Setting up NVMe RAID0..."
NVME_DISKS=($(lsblk -d -n -o NAME,TYPE | awk '$2=="disk" && $1~/^nvme/ && $1!~/nvme0/' | awk '{print "/dev/"$1}'))

if [ ${#NVME_DISKS[@]} -eq 0 ]; then
  echo "  No NVMe temp disks found, using OS disk for cache."
  mkdir -p "$NVME_DIR"
else
  if mountpoint -q "$NVME_DIR" 2>/dev/null; then
    echo "  $NVME_DIR already mounted, skipping RAID setup."
  else
    echo "  Found ${#NVME_DISKS[@]} NVMe disks: ${NVME_DISKS[*]}"

    # Stop any existing array
    mdadm --stop /dev/md0 2>/dev/null || true

    # Create RAID0
    mdadm --create /dev/md0 \
      --level=0 \
      --raid-devices=${#NVME_DISKS[@]} \
      "${NVME_DISKS[@]}" \
      --force --run

    # Format and mount
    mkfs.ext4 -F -E lazy_itable_init=0,lazy_journal_init=0 /dev/md0
    mkdir -p "$NVME_DIR"
    mount -o noatime,nodiratime /dev/md0 "$NVME_DIR"

    # Persist in fstab
    grep -q '/dev/md0' /etc/fstab || echo "/dev/md0 ${NVME_DIR} ext4 noatime,nodiratime,nofail 0 0" >> /etc/fstab

    # Save RAID config
    mdadm --detail --scan >> /etc/mdadm/mdadm.conf 2>/dev/null || true
    update-initramfs -u 2>/dev/null || true

    echo "  RAID0 mounted at $NVME_DIR ($(lsblk -d -n -o SIZE /dev/md0))"
  fi
fi

# Create overlay support dirs on NVMe
mkdir -p "$NVME_DIR/.work"
mkdir -p "$NVME_DIR/.docker"

# ─── 2. JuiceFS (durable storage) ─────────────────────────────
echo "[2/9] Setting up JuiceFS..."

# Validate required env vars
if [ -z "${STORAGE_ACCOUNT:-}" ] || [ -z "${STORAGE_KEY:-}" ] || \
   [ -z "${JUICEFS_CONTAINER:-}" ] || [ -z "${PG_HOST:-}" ] || [ -z "${PG_PASSWORD:-}" ]; then
  echo "  ERROR: STORAGE_ACCOUNT, STORAGE_KEY, JUICEFS_CONTAINER, PG_HOST, and PG_PASSWORD must be set."
  echo "  Source /etc/chiridion/storage.env before running this script."
  exit 1
fi

# Install JuiceFS
if ! command -v juicefs &>/dev/null; then
  curl -sSL https://d.juicefs.com/install | sh -
  echo "  JuiceFS installed."
else
  echo "  JuiceFS already installed."
fi

META_URL="postgres://chiridion:${PG_PASSWORD}@${PG_HOST}:5432/juicefs?sslmode=require"
BLOB_URL="https://${STORAGE_ACCOUNT}.blob.core.windows.net/${JUICEFS_CONTAINER}"

# Format volume (idempotent — skips if already formatted)
juicefs format \
  --storage wasb \
  --bucket "$BLOB_URL" \
  --access-key "$STORAGE_ACCOUNT" \
  --secret-key "$STORAGE_KEY" \
  "$META_URL" \
  chiridion-workspaces 2>&1 || true
echo "  JuiceFS volume formatted (or already exists)."

# Create cache dir on NVMe
mkdir -p "$NVME_DIR/jfs-cache"

# Mount JuiceFS
mkdir -p "$JUICEFS_DIR"
if mountpoint -q "$JUICEFS_DIR" 2>/dev/null; then
  echo "  $JUICEFS_DIR already mounted."
else
  juicefs mount \
    --cache-dir "$NVME_DIR/jfs-cache" \
    --cache-size 500000 \
    --background \
    "$META_URL" \
    "$JUICEFS_DIR"
  echo "  JuiceFS mounted at $JUICEFS_DIR"
fi

# Systemd mount unit for persistence across reboots
cat > /etc/systemd/system/mnt-juicefs.service << JEOF
[Unit]
Description=JuiceFS mount at /mnt/juicefs
After=network-online.target chiridion-nvme-raid.service
Wants=network-online.target
ConditionPathIsMountPoint=!/mnt/juicefs

[Service]
Type=forking
EnvironmentFile=/etc/chiridion/storage.env
ExecStart=/usr/local/bin/juicefs mount \
  --cache-dir /mnt/nvme/jfs-cache \
  --cache-size 500000 \
  --background \
  postgres://chiridion:\${PG_PASSWORD}@\${PG_HOST}:5432/juicefs?sslmode=require \
  /mnt/juicefs
ExecStop=/usr/local/bin/juicefs umount /mnt/juicefs
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
JEOF
systemctl daemon-reload
systemctl enable mnt-juicefs 2>/dev/null || true

# ─── 3. Workspace mount point directory ───────────────────────
echo "[3/9] Creating workspace mount point directory..."
mkdir -p "$WORKSPACES_DIR"

# ─── 4. Docker CE ────────────────────────────────────────────
echo "[4/9] Installing Docker CE..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "  Docker already installed."
fi

# ─── 5. gVisor (runsc) ──────────────────────────────────────
echo "[5/9] Installing gVisor..."
if ! command -v runsc &>/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc
else
  echo "  gVisor already installed."
fi

# ─── 6. Configure Docker with gVisor ─────────────────────────
echo "[6/9] Configuring Docker runtime..."
cat > /etc/docker/daemon.json << DEOF
{
  "runtimes": {
    "runsc": {
      "path": "/usr/bin/runsc"
    }
  },
  "data-root": "${NVME_DIR}/.docker"
}
DEOF
systemctl restart docker

# ─── 7. Bun runtime + systemd services ──────────────────────
echo "[7/9] Installing Bun and setting up services..."
if ! command -v bun &>/dev/null; then
  apt-get install -y -qq unzip >/dev/null 2>&1
  export HOME="${HOME:-/root}"
  curl -fsSL https://bun.sh/install | bash
  cp /root/.bun/bin/bun /usr/local/bin/bun
  chmod 755 /usr/local/bin/bun
else
  echo "  Bun already installed."
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Sandbox host service
cat > /etc/systemd/system/chiridion-sandbox-host.service << EOF
[Unit]
Description=Chiridion Sandbox Host
After=docker.service chiridion-nvme-raid.service mnt-juicefs.service
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${SERVICE_DIR}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PORT=80
Environment=WORKSPACES_ROOT=${WORKSPACES_DIR}
Environment=JFS_ROOT=${JUICEFS_DIR}
Environment=NVME_ROOT=${NVME_DIR}
Environment=SANDBOX_IMAGE=${SANDBOX_IMAGE}
Environment=CONTAINER_RUNTIME=runsc
EnvironmentFile=-/etc/chiridion/sandbox-host.env

[Install]
WantedBy=multi-user.target
EOF

# NVMe RAID0 rebuild on boot (NVMe temp disks are ephemeral)
cat > /etc/systemd/system/chiridion-nvme-raid.service << 'EOF'
[Unit]
Description=Rebuild NVMe RAID0 for workspace cache
Before=docker.service chiridion-sandbox-host.service
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/chiridion-rebuild-raid.sh

[Install]
WantedBy=multi-user.target
EOF

# RAID rebuild script (ephemeral NVMe — just rebuild, no data restore needed)
cat > /usr/local/bin/chiridion-rebuild-raid.sh << 'REOF'
#!/usr/bin/env bash
set -euo pipefail

NVME_DIR="/mnt/nvme"

# Check if already mounted
if mountpoint -q "$NVME_DIR" 2>/dev/null; then
  echo "[RAID] $NVME_DIR already mounted."
  exit 0
fi

# Find NVMe temp disks (exclude nvme0 which is the OS disk)
NVME_DISKS=($(lsblk -d -n -o NAME,TYPE | awk '$2=="disk" && $1~/^nvme/ && $1!~/nvme0/' | awk '{print "/dev/"$1}'))

if [ ${#NVME_DISKS[@]} -eq 0 ]; then
  echo "[RAID] No NVMe temp disks, using OS disk."
  mkdir -p "$NVME_DIR"
  exit 0
fi

echo "[RAID] Rebuilding RAID0 from ${#NVME_DISKS[@]} disks: ${NVME_DISKS[*]}"
mdadm --stop /dev/md0 2>/dev/null || true
mdadm --create /dev/md0 \
  --level=0 \
  --raid-devices=${#NVME_DISKS[@]} \
  "${NVME_DISKS[@]}" \
  --force --run

mkfs.ext4 -F -E lazy_itable_init=0,lazy_journal_init=0 /dev/md0
mkdir -p "$NVME_DIR"
mount -o noatime,nodiratime /dev/md0 "$NVME_DIR"

# Create overlay support dirs
mkdir -p "$NVME_DIR/.work"
mkdir -p "$NVME_DIR/.docker"

echo "[RAID] RAID0 rebuilt at $NVME_DIR. Overlay upper layers start empty (JuiceFS has canonical data)."
REOF
chmod +x /usr/local/bin/chiridion-rebuild-raid.sh

systemctl daemon-reload
systemctl enable chiridion-nvme-raid 2>/dev/null || true

# ─── 8. cloudflared (Cloudflare Tunnel for VPC) ──────────────
echo "[8/9] Installing cloudflared..."
if ! command -v cloudflared &>/dev/null; then
  mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared $(lsb_release -cs) main" \
    > /etc/apt/sources.list.d/cloudflared.list
  apt-get update -qq && apt-get install -y -qq cloudflared >/dev/null 2>&1
  echo "  cloudflared installed."
else
  echo "  cloudflared already installed."
fi

if [ -n "${CLOUDFLARED_TUNNEL_TOKEN:-}" ]; then
  cloudflared service install "$CLOUDFLARED_TUNNEL_TOKEN" 2>/dev/null || true
  systemctl enable --now cloudflared 2>/dev/null || true
  echo "  cloudflared tunnel service configured and started."
else
  echo "  WARNING: CLOUDFLARED_TUNNEL_TOKEN not set, skipping tunnel setup."
fi

# ─── 9. Azure Container Registry login + pull ────────────────
if [ -n "${ACR_LOGIN_SERVER:-}" ]; then
  echo "[9/9] Setting up ACR image pull..."

  # Install Azure CLI (needed for az acr login with managed identity)
  if ! command -v az &>/dev/null; then
    curl -sL https://aka.ms/InstallAzureCLIDeb | bash >/dev/null 2>&1
    echo "  Azure CLI installed."
  else
    echo "  Azure CLI already installed."
  fi

  # Login to ACR using VM managed identity
  az acr login --name "${ACR_LOGIN_SERVER%%.*}" --identity 2>/dev/null || true
  echo "  Logged into ACR: ${ACR_LOGIN_SERVER}"

  # Pull the sandbox image
  docker pull "$SANDBOX_IMAGE" 2>&1 || echo "  WARNING: Image pull failed. Push image to ACR first."
else
  echo "[9/9] Skipping ACR setup (no ACR_LOGIN_SERVER configured)."
fi

# ─── Start services ──────────────────────────────────────────
echo ""
echo "Starting sandbox host service..."
systemctl enable --now chiridion-sandbox-host 2>/dev/null || true

echo ""
echo "=== Setup complete ==="
echo ""
echo "Storage layout (overlayfs tiered):"
echo "  /mnt/nvme           - NVMe RAID0 cache (overlay upper layers, ~3.5TB)"
echo "  /mnt/juicefs        - JuiceFS (overlay lower layers, canonical data)"
echo "  /mnt/workspaces     - Per-workspace overlayfs merged mounts"
echo "  /mnt/nvme/.docker   - Docker data root"
echo "  /mnt/nvme/jfs-cache - JuiceFS local cache on NVMe"
echo ""
echo "On reboot: NVMe RAID0 is rebuilt (empty cache). JuiceFS has all canonical data."
echo "Per-workspace overlayfs mounts are created on-demand by sandbox-host."
echo ""
echo "To build sandbox image:"
echo "  docker build -t chiridion-sandbox:latest -f Dockerfile.sandbox /opt/chiridion/"
echo ""
echo "To start the service:"
echo "  sudo systemctl enable --now chiridion-sandbox-host"
echo ""
echo "To verify:"
echo "  curl http://localhost/health"
