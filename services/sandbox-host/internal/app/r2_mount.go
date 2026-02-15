package app

import (
	"log"
	"os"
	"os/exec"
	"strings"
	"time"
)

func MountR2OnHost() {
	accessKey := strings.TrimSpace(os.Getenv("R2_ACCESS_KEY_ID"))
	secretKey := strings.TrimSpace(os.Getenv("R2_SECRET_ACCESS_KEY"))
	accountID := strings.TrimSpace(os.Getenv("R2_ACCOUNT_ID"))
	bucketName := strings.TrimSpace(os.Getenv("R2_BUCKET_NAME"))
	mountRoot := strings.TrimSpace(os.Getenv("R2_MOUNT_ROOT"))
	if mountRoot == "" {
		mountRoot = "/mnt/r2"
	}

	uid := strings.TrimSpace(os.Getenv("R2_MOUNT_UID"))
	if uid == "" {
		uid = "1001"
	}
	gid := strings.TrimSpace(os.Getenv("R2_MOUNT_GID"))
	if gid == "" {
		gid = "1001"
	}
	umask := strings.TrimSpace(os.Getenv("R2_MOUNT_UMASK"))
	if umask == "" {
		umask = "002"
	}

	if accessKey == "" || secretKey == "" || accountID == "" || bucketName == "" {
		log.Printf("[SandboxHost] R2 credentials not configured, skipping host mount")
		return
	}

	mountOutput, mountErr := exec.Command("mount").Output()
	if mountErr == nil && strings.Contains(string(mountOutput), mountRoot) {
		log.Printf("[SandboxHost] R2 already mounted at %s", mountRoot)
		return
	}

	if err := os.MkdirAll(mountRoot, 0o755); err != nil {
		log.Printf("[SandboxHost] failed to create R2 mount root: %v", err)
		return
	}

	configPath := "/tmp/rclone-r2.conf"
	configContents := strings.Join([]string{
		"[r2]",
		"type = s3",
		"provider = Cloudflare",
		"access_key_id = " + accessKey,
		"secret_access_key = " + secretKey,
		"endpoint = https://" + accountID + ".r2.cloudflarestorage.com",
	}, "\n")
	if err := os.WriteFile(configPath, []byte(configContents), 0o600); err != nil {
		log.Printf("[SandboxHost] failed to write rclone config: %v", err)
		return
	}

	cmd := exec.Command(
		"rclone",
		"mount",
		"--daemon",
		"r2:"+bucketName,
		mountRoot,
		"--config="+configPath,
		"--allow-other",
		"--uid="+uid,
		"--gid="+gid,
		"--umask="+umask,
		"--dir-cache-time=5s",
		"--vfs-cache-mode=writes",
		"--vfs-write-back=0",
	)
	output, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[SandboxHost] Failed to mount R2 bucket: %v: %s", err, strings.TrimSpace(string(output)))
		return
	}
	log.Printf("[SandboxHost] R2 bucket mounted at %s", mountRoot)
	if text := strings.TrimSpace(string(output)); text != "" {
		log.Printf("[SandboxHost] rclone mount output: %s", text)
	}

	time.Sleep(1 * time.Second)
	if _, err := os.Stat(mountRoot); err == nil {
		log.Printf("[SandboxHost] R2 mount verified at %s", mountRoot)
	} else {
		log.Printf("[SandboxHost] R2 mount point not accessible after mount: %v", err)
	}

}
