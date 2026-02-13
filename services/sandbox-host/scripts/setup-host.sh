#!/usr/bin/env bash
#
# Azure VM provisioning script for Chiridion sandbox host.
# Sets up: NVMe RAID0 (cache), Azure Blob NFS v3 (durable canonical),
# overlayfs (per-workspace tiered mounts), Docker + gVisor, Bun.
#
# Storage layout:
#   /mnt/nvme        - NVMe RAID0 (fast ephemeral, overlay upper layers)
#   /mnt/nfs         - Azure Blob NFS v3 (durable canonical, overlay lower layers)
#   /mnt/workspaces  - Per-workspace overlayfs merged mount points
#   /mnt/nvme/.docker - Docker data root
#
# Required environment variables (from /etc/chiridion/storage.env):
#   STORAGE_ACCOUNT - Azure Blob storage account name
#   BLOB_CONTAINER  - Blob container name for workspace data
#
# Usage: sudo bash setup-host.sh
#
set -euo pipefail

echo "=== Chiridion Sandbox Host Setup ==="

# ─── Config ──────────────────────────────────────────────────
NVME_DIR="/mnt/nvme"
NFS_DIR="/mnt/nfs"
WORKSPACES_DIR="/mnt/workspaces"

# ─── 1. NVMe RAID0 ──────────────────────────────────────────
echo "[1/7] Setting up NVMe RAID0..."
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

# ─── 2. Azure Blob NFS v3 Mount ─────────────────────────────
echo "[2/7] Setting up Azure Blob NFS v3 mount..."

# Validate required env vars
if [ -z "${STORAGE_ACCOUNT:-}" ] || [ -z "${BLOB_CONTAINER:-}" ]; then
  echo "  ERROR: STORAGE_ACCOUNT and BLOB_CONTAINER must be set."
  echo "  Source /etc/chiridion/storage.env before running this script."
  exit 1
fi

apt-get update -qq && apt-get install -y -qq nfs-common >/dev/null 2>&1
mkdir -p "$NFS_DIR"

NFS_MOUNT_TARGET="${STORAGE_ACCOUNT}.blob.core.windows.net:/${STORAGE_ACCOUNT}/${BLOB_CONTAINER}"

if mountpoint -q "$NFS_DIR" 2>/dev/null; then
  echo "  $NFS_DIR already mounted."
else
  mount -t nfs -o sec=sys,vers=3,nolock,proto=tcp "$NFS_MOUNT_TARGET" "$NFS_DIR"
  echo "  NFS v3 mounted at $NFS_DIR"
fi

# Persist in fstab
grep -q "$NFS_MOUNT_TARGET" /etc/fstab || \
  echo "${NFS_MOUNT_TARGET} ${NFS_DIR} nfs sec=sys,vers=3,nolock,proto=tcp,nofail 0 0" >> /etc/fstab

# ─── 3. Workspace mount point directory ───────────────────────
echo "[3/7] Creating workspace mount point directory..."
mkdir -p "$WORKSPACES_DIR"

# ─── 4. Docker CE ────────────────────────────────────────────
echo "[4/7] Installing Docker CE..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "  Docker already installed."
fi

# ─── 5. gVisor (runsc) ──────────────────────────────────────
echo "[5/7] Installing gVisor..."
if ! command -v runsc &>/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc
else
  echo "  gVisor already installed."
fi

# ─── 6. Configure Docker with gVisor ─────────────────────────
echo "[6/7] Configuring Docker runtime..."
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
echo "[7/7] Installing Bun and setting up services..."
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
After=docker.service mnt-nvme.mount mnt-nfs.mount
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${SERVICE_DIR}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PORT=80
Environment=WORKSPACES_ROOT=${WORKSPACES_DIR}
Environment=NFS_ROOT=${NFS_DIR}
Environment=NVME_ROOT=${NVME_DIR}
Environment=SANDBOX_IMAGE=chiridion-sandbox:latest
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

echo "[RAID] RAID0 rebuilt at $NVME_DIR. Overlay upper layers start empty (NFS has canonical data)."
REOF
chmod +x /usr/local/bin/chiridion-rebuild-raid.sh

systemctl daemon-reload
systemctl enable chiridion-nvme-raid 2>/dev/null || true

echo ""
echo "=== Setup complete ==="
echo ""
echo "Storage layout (overlayfs tiered):"
echo "  /mnt/nvme        - NVMe RAID0 cache (overlay upper layers, ~3.5TB)"
echo "  /mnt/nfs         - Azure Blob NFS v3 (overlay lower layers, canonical data)"
echo "  /mnt/workspaces  - Per-workspace overlayfs merged mounts"
echo "  /mnt/nvme/.docker - Docker data root"
echo ""
echo "On reboot: NVMe RAID0 is rebuilt (empty cache). NFS has all canonical data."
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
