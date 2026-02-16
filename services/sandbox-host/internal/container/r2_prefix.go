package container

import (
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"
)

// ensureR2Prefix creates .keep marker objects on R2 via rclone (S3 API, not FUSE)
// so that the host-level rclone FUSE mount sees the directories for bind-mounting.
// Both directories are created in parallel.
func ensureR2Prefix(rcloneConfPath, bucket, prefix string) error {
	uploadsKey := fmt.Sprintf("r2:%s/%s/user-uploads/.keep", bucket, prefix)
	outputsKey := fmt.Sprintf("r2:%s/%s/user-outputs/.keep", bucket, prefix)

	var wg sync.WaitGroup
	var errUploads, errOutputs error

	wg.Add(2)
	go func() {
		defer wg.Done()
		errUploads = rcloneRcat(rcloneConfPath, uploadsKey)
	}()
	go func() {
		defer wg.Done()
		errOutputs = rcloneRcat(rcloneConfPath, outputsKey)
	}()
	wg.Wait()

	if errUploads != nil {
		return fmt.Errorf("create user-uploads marker: %w", errUploads)
	}
	if errOutputs != nil {
		return fmt.Errorf("create user-outputs marker: %w", errOutputs)
	}
	return nil
}

// waitForR2Dir polls the host FUSE mount path until the directory appears.
func waitForR2Dir(path string, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		info, err := os.Stat(path)
		if err == nil && info.IsDir() {
			return true
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}

func rcloneRcat(confPath, remotePath string) error {
	cmd := exec.Command("rclone", "rcat", "--config", confPath, remotePath)
	cmd.Stdin = strings.NewReader("")
	out, err := cmd.CombinedOutput()
	if err != nil {
		log.Printf("[R2Prefix] rclone rcat %s failed: %s", remotePath, string(out))
		return err
	}
	return nil
}
