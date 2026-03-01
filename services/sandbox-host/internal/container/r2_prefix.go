package container

import (
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// ensureR2Prefix creates the user-uploads and user-outputs directories through
// the s3fs FUSE mount. Since s3fs writes are synchronous (upload completes on
// close()), the directories exist in R2 immediately after os.MkdirAll returns.
func ensureR2Prefix(r2MountRoot, prefix string) error {
	uploadsDir := filepath.Join(r2MountRoot, prefix, "user-uploads")
	outputsDir := filepath.Join(r2MountRoot, prefix, "user-outputs")

	if err := os.MkdirAll(uploadsDir, 0755); err != nil {
		return fmt.Errorf("create user-uploads dir: %w", err)
	}
	if err := os.MkdirAll(outputsDir, 0755); err != nil {
		return fmt.Errorf("create user-outputs dir: %w", err)
	}

	// Write .keep markers so the directories persist as S3 prefixes
	for _, dir := range []string{uploadsDir, outputsDir} {
		keepPath := filepath.Join(dir, ".keep")
		if _, err := os.Stat(keepPath); os.IsNotExist(err) {
			if err := os.WriteFile(keepPath, []byte{}, 0644); err != nil {
				return fmt.Errorf("write %s: %w", keepPath, err)
			}
		}
	}

	return nil
}

// waitForR2Dir verifies the directory exists on the FUSE mount.
// With s3fs (synchronous writes), this is mainly a sanity check.
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
