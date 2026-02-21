package app

import "testing"

func TestRcloneMountArgsIncludesUserOwnership(t *testing.T) {
	cfg := &R2MountConfig{
		MountRoot:      "/mnt/r2",
		RcloneConfPath: "/tmp/rclone.conf",
		MountUID:       "1001",
		MountGID:       "1001",
	}

	args := rcloneMountArgs(cfg, "r2:test-bucket")

	if !containsArgPair(args, "--uid", "1001") {
		t.Fatalf("expected --uid 1001 in args: %v", args)
	}
	if !containsArgPair(args, "--gid", "1001") {
		t.Fatalf("expected --gid 1001 in args: %v", args)
	}
}

func containsArgPair(args []string, key, value string) bool {
	for i := 0; i < len(args)-1; i++ {
		if args[i] == key && args[i+1] == value {
			return true
		}
	}
	return false
}
