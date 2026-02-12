#!/usr/bin/env bash
#
# Azure VM provisioning script for Chiridion sandbox host.
# Sets up: NVMe RAID0 (hot storage), Azure Files NFS (durable backing),
# lsyncd (near-real-time sync), Docker + gVisor, Caddy, Bun.
#
# Usage: sudo bash setup-host.sh
#
set -euo pipefail

echo "=== Chiridion Sandbox Host Setup ==="

# ─── Config ──────────────────────────────────────────────────
WORKSPACES_DIR="/mnt/workspaces"
NFS_MOUNT="/mnt/backing"
STORAGE_ACCOUNT="${AZURE_STORAGE_ACCOUNT:-chiridionstoragefiles}"
NFS_SHARE="${AZURE_NFS_SHARE:-workspaces}"
STORAGE_ACCOUNT_URL="${STORAGE_ACCOUNT}.file.core.windows.net:/${STORAGE_ACCOUNT}/${NFS_SHARE}"

# ─── 1. NVMe RAID0 ──────────────────────────────────────────
echo "[1/10] Setting up NVMe RAID0..."
NVME_DISKS=($(lsblk -d -n -o NAME,TYPE | awk '$2=="disk" && $1~/^nvme/ && $1!~/nvme0/' | awk '{print "/dev/"$1}'))

if [ ${#NVME_DISKS[@]} -eq 0 ]; then
  echo "  No NVMe temp disks found, using OS disk for workspaces."
  mkdir -p "$WORKSPACES_DIR"
else
  if mountpoint -q "$WORKSPACES_DIR" 2>/dev/null; then
    echo "  $WORKSPACES_DIR already mounted, skipping RAID setup."
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
    mkdir -p "$WORKSPACES_DIR"
    mount -o noatime,nodiratime /dev/md0 "$WORKSPACES_DIR"

    # Persist in fstab
    grep -q '/dev/md0' /etc/fstab || echo '/dev/md0 /mnt/workspaces ext4 noatime,nodiratime,nofail 0 0' >> /etc/fstab

    # Save RAID config
    mdadm --detail --scan >> /etc/mdadm/mdadm.conf 2>/dev/null || true
    update-initramfs -u 2>/dev/null || true

    echo "  RAID0 mounted at $WORKSPACES_DIR ($(lsblk -d -n -o SIZE /dev/md0))"
  fi
fi
chown 1001:1001 "$WORKSPACES_DIR"

# ─── 2. Azure Files NFS Mount ────────────────────────────────
echo "[2/10] Setting up Azure Files NFS mount..."
apt-get update -qq && apt-get install -y -qq nfs-common >/dev/null 2>&1
mkdir -p "$NFS_MOUNT"

if mountpoint -q "$NFS_MOUNT" 2>/dev/null; then
  echo "  $NFS_MOUNT already mounted."
else
  mount -t nfs "${STORAGE_ACCOUNT_URL}" "$NFS_MOUNT" -o vers=4,minorversion=1,sec=sys,nconnect=4
  echo "  NFS mounted at $NFS_MOUNT"
fi

# Persist in fstab
grep -q "$STORAGE_ACCOUNT_URL" /etc/fstab || \
  echo "${STORAGE_ACCOUNT_URL} ${NFS_MOUNT} nfs vers=4,minorversion=1,sec=sys,nconnect=4,nofail 0 0" >> /etc/fstab

# ─── 3. lsyncd (NVMe → NFS near-real-time sync) ──────────────
echo "[3/10] Setting up lsyncd..."
apt-get install -y -qq lsyncd >/dev/null 2>&1

mkdir -p /etc/lsyncd /var/log/lsyncd

cat > /etc/lsyncd/lsyncd.conf.lua << 'EOF'
settings {
  logfile    = "/var/log/lsyncd/lsyncd.log",
  statusFile = "/var/log/lsyncd/lsyncd.status",
  maxProcesses = 4,
  maxDelays  = 1,
}

sync {
  default.rsync,
  source = "/mnt/workspaces/",
  target = "/mnt/backing/",
  delay  = 3,
  rsync  = {
    archive  = true,
    compress = false,
    whole_file = true,
    _extra = {"--delete", "--inplace"},
  },
}
EOF

# Enable and start lsyncd
systemctl enable lsyncd 2>/dev/null || true
systemctl restart lsyncd 2>/dev/null || true
echo "  lsyncd configured: $WORKSPACES_DIR → $NFS_MOUNT (3s delay)"

# ─── 4. Docker CE ────────────────────────────────────────────
echo "[4/10] Installing Docker CE..."
if ! command -v docker &>/dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
else
  echo "  Docker already installed."
fi

# ─── 5. gVisor (runsc) ──────────────────────────────────────
echo "[5/10] Installing gVisor..."
if ! command -v runsc &>/dev/null; then
  curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
    > /etc/apt/sources.list.d/gvisor.list
  apt-get update -qq && apt-get install -y -qq runsc
else
  echo "  gVisor already installed."
fi

# ─── 6. Configure Docker with gVisor ─────────────────────────
echo "[6/10] Configuring Docker runtime..."
cat > /etc/docker/daemon.json << 'DEOF'
{
  "runtimes": {
    "runsc": {
      "path": "/usr/bin/runsc"
    }
  },
  "data-root": "/mnt/workspaces/.docker"
}
DEOF
systemctl restart docker

# ─── 7. Caddy (TLS termination) ─────────────────────────────
echo "[7/10] Installing Caddy..."
if ! command -v caddy &>/dev/null; then
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https >/dev/null 2>&1
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy
else
  echo "  Caddy already installed."
fi

# ─── 8. Bun runtime ─────────────────────────────────────────
echo "[8/10] Installing Bun..."
if ! command -v bun &>/dev/null; then
  curl -fsSL https://bun.sh/install | bash
  ln -sf /root/.bun/bin/bun /usr/local/bin/bun
else
  echo "  Bun already installed."
fi

# ─── 9. Build sandbox image ─────────────────────────────────
echo "[9/10] Building sandbox image..."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
docker build \
  -t chiridion-sandbox:latest \
  -f "${SCRIPT_DIR}/../Dockerfile.sandbox" \
  "${REPO_ROOT}"

# ─── 10. Systemd services ───────────────────────────────────
echo "[10/10] Setting up systemd services..."
SERVICE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Sandbox host service
cat > /etc/systemd/system/chiridion-sandbox-host.service << EOF
[Unit]
Description=Chiridion Sandbox Host
After=docker.service mnt-workspaces.mount mnt-backing.mount
Requires=docker.service

[Service]
Type=simple
WorkingDirectory=${SERVICE_DIR}
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=always
RestartSec=5
Environment=PORT=4400
Environment=WORKSPACES_ROOT=/mnt/workspaces
Environment=SANDBOX_IMAGE=chiridion-sandbox:latest
Environment=CONTAINER_RUNTIME=runsc
EnvironmentFile=-/etc/chiridion/sandbox-host.env

[Install]
WantedBy=multi-user.target
EOF

# NVMe RAID0 rebuild on boot (NVMe temp disks are ephemeral)
cat > /etc/systemd/system/chiridion-nvme-raid.service << 'EOF'
[Unit]
Description=Rebuild NVMe RAID0 for workspace storage
Before=docker.service chiridion-sandbox-host.service
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/bin/chiridion-rebuild-raid.sh

[Install]
WantedBy=multi-user.target
EOF

# RAID rebuild script
cat > /usr/local/bin/chiridion-rebuild-raid.sh << 'REOF'
#!/usr/bin/env bash
set -euo pipefail

WORKSPACES_DIR="/mnt/workspaces"
NFS_MOUNT="/mnt/backing"

# Check if already mounted
if mountpoint -q "$WORKSPACES_DIR" 2>/dev/null; then
  echo "[RAID] $WORKSPACES_DIR already mounted."
  exit 0
fi

# Find NVMe temp disks (exclude nvme0 which is the OS disk)
NVME_DISKS=($(lsblk -d -n -o NAME,TYPE | awk '$2=="disk" && $1~/^nvme/ && $1!~/nvme0/' | awk '{print "/dev/"$1}'))

if [ ${#NVME_DISKS[@]} -eq 0 ]; then
  echo "[RAID] No NVMe temp disks, using OS disk."
  mkdir -p "$WORKSPACES_DIR"
  chown 1001:1001 "$WORKSPACES_DIR"
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
mkdir -p "$WORKSPACES_DIR"
mount -o noatime,nodiratime /dev/md0 "$WORKSPACES_DIR"
chown 1001:1001 "$WORKSPACES_DIR"

echo "[RAID] RAID0 rebuilt. Restoring from NFS backing..."
if mountpoint -q "$NFS_MOUNT" 2>/dev/null && [ -d "$NFS_MOUNT" ]; then
  rsync -a --whole-file "$NFS_MOUNT/" "$WORKSPACES_DIR/"
  chown -R 1001:1001 "$WORKSPACES_DIR"
  echo "[RAID] Restored $(du -sh "$WORKSPACES_DIR" | cut -f1) from NFS backing."
else
  echo "[RAID] NFS not mounted yet, starting fresh."
fi
REOF
chmod +x /usr/local/bin/chiridion-rebuild-raid.sh

# Copy Caddyfile
cp "${SCRIPT_DIR}/../Caddyfile" /etc/caddy/Caddyfile
systemctl reload caddy 2>/dev/null || systemctl restart caddy

systemctl daemon-reload
systemctl enable chiridion-nvme-raid 2>/dev/null || true

echo ""
echo "=== Setup complete ==="
echo ""
echo "Storage layout:"
echo "  /mnt/workspaces  - NVMe RAID0 (hot, ~3.5TB, ephemeral)"
echo "  /mnt/backing     - Azure Files NFS (durable, shared)"
echo "  lsyncd           - syncs workspaces → backing every 3s"
echo ""
echo "On reboot: RAID0 is rebuilt from NVMe, data restored from NFS."
echo ""
echo "To start the service:"
echo "  sudo systemctl enable --now chiridion-sandbox-host"
echo ""
echo "To configure auth token:"
echo "  mkdir -p /etc/chiridion"
echo '  echo "SANDBOX_HOST_TOKEN=your-secret-token" > /etc/chiridion/sandbox-host.env'
echo ""
echo "To verify:"
echo "  curl http://localhost:4400/health"
echo "  systemctl status lsyncd"
echo "  cat /var/log/lsyncd/lsyncd.status"
