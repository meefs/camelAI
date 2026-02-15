#!/usr/bin/env bash
#
# One-time migration from flat NVMe layout to overlayfs tiered layout.
#
# Before: /mnt/workspaces (NVMe RAID0) - all workspace data + Docker
#         /mnt/backing (NFS) - lsyncd backup
#
# After:  /mnt/nvme (NVMe RAID0) - overlay upper layers + Docker data
#         /mnt/nfs (NFS) - canonical workspace data (overlay lower layers)
#         /mnt/workspaces - per-workspace overlayfs mount points
#
# This script:
# 1. Stops all services and containers
# 2. Syncs workspace data from NVMe to NFS (ensures NFS is canonical)
# 3. Remounts NVMe RAID0 at /mnt/nvme
# 4. Creates symlink /mnt/nfs → /mnt/backing (or remounts)
# 5. Creates /mnt/workspaces as a regular directory
# 6. Moves Docker data root to /mnt/nvme/.docker
# 7. Updates fstab
#
# Usage: sudo bash migrate-to-overlay.sh
#
set -euo pipefail

echo "=== Migrating to OverlayFS tiered storage ==="
echo ""
echo "WARNING: This will stop all containers and the sandbox-host service."
echo "Press Ctrl+C to abort, or Enter to continue..."
read -r

# ─── 1. Stop everything ──────────────────────────────────────
echo "[1/7] Stopping services and containers..."
systemctl stop chiridion-sandbox-host 2>/dev/null || true
systemctl stop lsyncd 2>/dev/null || true
systemctl disable lsyncd 2>/dev/null || true

# Kill any running sandbox-host process
pkill -f 'chiridion-sandbox-host' 2>/dev/null || true

# Stop and remove all containers
docker stop $(docker ps -q) 2>/dev/null || true
docker rm $(docker ps -aq) 2>/dev/null || true
systemctl stop docker

echo "  Done."

# ─── 2. Sync workspace data NVMe → NFS ───────────────────────
echo "[2/7] Syncing workspace data to NFS (this may take a while)..."
# Only sync actual workspace dirs, not Docker data
rsync -a --whole-file --delete \
  --exclude='.docker' \
  --exclude='lost+found' \
  --exclude='test-sandbox' \
  --exclude='test-reaper' \
  --exclude='test.txt' \
  /mnt/workspaces/ /mnt/backing/
echo "  Synced $(du -sh /mnt/backing/ 2>/dev/null | cut -f1) to NFS."

# ─── 3. Remount NVMe at /mnt/nvme ────────────────────────────
echo "[3/7] Remounting NVMe RAID0 at /mnt/nvme..."
umount /mnt/workspaces 2>/dev/null || true
mkdir -p /mnt/nvme
mount -o noatime,nodiratime /dev/md0 /mnt/nvme

# Update fstab: change /mnt/workspaces → /mnt/nvme
sed -i 's|/mnt/workspaces|/mnt/nvme|g' /etc/fstab
echo "  NVMe remounted at /mnt/nvme"

# ─── 4. Set up /mnt/nfs ──────────────────────────────────────
echo "[4/7] Setting up /mnt/nfs..."
# Remount NFS at /mnt/nfs instead of /mnt/backing
umount /mnt/backing 2>/dev/null || true
mkdir -p /mnt/nfs

STORAGE_ACCOUNT_URL=$(grep 'file.core.windows.net' /etc/fstab | awk '{print $1}')
mount -t nfs "$STORAGE_ACCOUNT_URL" /mnt/nfs -o vers=4,minorversion=1,sec=sys,nconnect=4

# Update fstab: change /mnt/backing → /mnt/nfs
sed -i 's|/mnt/backing|/mnt/nfs|g' /etc/fstab
rmdir /mnt/backing 2>/dev/null || true
echo "  NFS remounted at /mnt/nfs"

# ─── 5. Create workspace mount point directory ────────────────
echo "[5/7] Creating /mnt/workspaces mount point directory..."
mkdir -p /mnt/workspaces

# ─── 6. Relocate Docker data root ────────────────────────────
echo "[6/7] Moving Docker data root to /mnt/nvme/.docker..."
# Docker data was at /mnt/workspaces/.docker (now /mnt/nvme/.docker — same physical location)
mkdir -p /mnt/nvme/.docker
mkdir -p /mnt/nvme/.work

# Update Docker daemon config
cat > /etc/docker/daemon.json << 'EOF'
{
  "runtimes": {
    "runsc": {
      "path": "/usr/bin/runsc"
    }
  },
  "data-root": "/mnt/nvme/.docker"
}
EOF

systemctl start docker
echo "  Docker data root set to /mnt/nvme/.docker"

# ─── 7. Verify ───────────────────────────────────────────────
echo "[7/7] Verifying layout..."
echo ""
echo "Mount points:"
df -h /mnt/nvme /mnt/nfs 2>/dev/null || true
echo ""
echo "NFS workspace count: $(ls /mnt/nfs | wc -l)"
echo "NVMe usage: $(du -sh /mnt/nvme 2>/dev/null | cut -f1)"
echo ""
echo "=== Migration complete ==="
echo ""
echo "Next steps:"
echo "  1. Start sandbox-host with overlay env vars:"
echo "     WORKSPACES_ROOT=/mnt/workspaces NFS_ROOT=/mnt/nfs NVME_ROOT=/mnt/nvme go run ./cmd/sandbox-host"
echo "  2. Test: curl -X POST -H 'Authorization: Bearer ...' http://localhost:4400/v1/sandboxes/test-overlay"
echo "  3. Verify overlay mount: mount | grep overlay | grep workspaces"
echo ""
