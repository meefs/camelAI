package app

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// R2MountConfig holds settings for the host-level rclone R2 FUSE mount.
type R2MountConfig struct {
	MountRoot       string // e.g. /mnt/r2
	RcloneConfPath  string // written at mount time
	AccountID       string
	AccessKeyID     string
	SecretAccessKey string
	BucketName      string
	MountUID        string
	MountGID        string
}

// LoadR2MountConfig reads the R2 mount configuration from env.
func LoadR2MountConfig() *R2MountConfig {
	accountID := envString("R2_ACCOUNT_ID", "")
	accessKeyID := envString("R2_ACCESS_KEY_ID", "")
	secretAccessKey := envString("R2_SECRET_ACCESS_KEY", "")
	bucketName := envString("R2_BUCKET_NAME", "")

	if accountID == "" || accessKeyID == "" || secretAccessKey == "" || bucketName == "" {
		return nil
	}

	mountRoot := envString("R2_MOUNT_ROOT", defaultR2MountRoot())
	mountUID := envString("R2_MOUNT_UID", "1001")
	mountGID := envString("R2_MOUNT_GID", "1001")
	return &R2MountConfig{
		MountRoot:       mountRoot,
		RcloneConfPath:  filepath.Join(os.TempDir(), "rclone-r2-host.conf"),
		AccountID:       accountID,
		AccessKeyID:     accessKeyID,
		SecretAccessKey: secretAccessKey,
		BucketName:      bucketName,
		MountUID:        mountUID,
		MountGID:        mountGID,
	}
}

// MountR2OnHost starts a rclone FUSE mount of the R2 bucket on the host.
// Non-blocking: starts rclone in the background and waits for the mount to appear.
func MountR2OnHost(cfg *R2MountConfig) error {
	if cfg == nil {
		log.Println("[R2Mount] R2 credentials not configured, skipping host mount")
		return nil
	}

	// Clean up stale FUSE mount if present (e.g. from a previous crash).
	// Always try fusermount -uz: it's a no-op if nothing is mounted, and
	// handles the case where isMounted/Stat fails on a disconnected endpoint.
	_ = exec.Command("fusermount", "-uz", cfg.MountRoot).Run()

	if err := os.MkdirAll(cfg.MountRoot, 0o755); err != nil {
		return fmt.Errorf("failed to create R2 mount root %s: %w", cfg.MountRoot, err)
	}

	endpoint := fmt.Sprintf("https://%s.r2.cloudflarestorage.com", cfg.AccountID)
	confContent := fmt.Sprintf(`[r2]
type = s3
provider = Cloudflare
access_key_id = %s
secret_access_key = %s
endpoint = %s
no_check_bucket = true
`, cfg.AccessKeyID, cfg.SecretAccessKey, endpoint)

	if err := os.WriteFile(cfg.RcloneConfPath, []byte(confContent), 0o600); err != nil {
		return fmt.Errorf("failed to write rclone config: %w", err)
	}

	remote := fmt.Sprintf("r2:%s", cfg.BucketName)
	cmd := exec.Command("rclone", rcloneMountArgs(cfg, remote)...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr

	if err := cmd.Start(); err != nil {
		return fmt.Errorf("failed to start rclone mount: %w", err)
	}

	// Wait for the mount to appear (rclone foreground mode mounts immediately).
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		if isMounted(cfg.MountRoot) {
			log.Printf("[R2Mount] host R2 mount ready at %s", cfg.MountRoot)
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}

	return fmt.Errorf("rclone mount at %s did not appear within 30s", cfg.MountRoot)
}

func isMounted(path string) bool {
	data, err := os.ReadFile("/proc/mounts")
	if err != nil {
		// Fallback: try to stat the path for FUSE characteristics.
		info, statErr := os.Stat(path)
		return statErr == nil && info.IsDir()
	}
	return strings.Contains(string(data), " "+path+" ")
}

func defaultR2MountRoot() string {
	if runtime.GOOS == "linux" {
		return "/mnt/r2"
	}
	return ""
}

func rcloneMountArgs(cfg *R2MountConfig, remote string) []string {
	return []string{
		"mount",
		"--config", cfg.RcloneConfPath,
		"--dir-cache-time", "5s",
		"--vfs-cache-mode", "writes",
		"--vfs-write-back", "0",
		"--allow-other",
		// Match ownership to the in-container "claude" user (uid/gid 1001)
		// so /mnt/user-outputs stays writable after bind-mounting into sandboxes.
		"--uid", cfg.MountUID,
		"--gid", cfg.MountGID,
		remote,
		cfg.MountRoot,
	}
}
