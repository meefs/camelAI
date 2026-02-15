package fsops

import (
	"os"
	"path/filepath"
	"testing"
)

func TestResolveHostPathMapsHomePrefix(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root)

	got, err := mgr.ResolveHostPath("sandbox-a", "/home/claude/src/main.ts")
	if err != nil {
		t.Fatalf("resolve failed: %v", err)
	}

	want := filepath.Join(root, "sandbox-a", "src", "main.ts")
	if got != want {
		t.Fatalf("unexpected host path: got %q want %q", got, want)
	}
}

func TestResolveHostPathRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root)

	_, err := mgr.ResolveHostPath("sandbox-a", "../../etc/passwd")
	if err == nil {
		t.Fatal("expected traversal error")
	}
}

func TestWriteAndExists(t *testing.T) {
	root := t.TempDir()
	mgr := NewManager(root)

	if err := mgr.Write("sandbox-a", "/notes.txt", []byte("hello")); err != nil {
		t.Fatalf("write failed: %v", err)
	}

	result, err := mgr.Exists("sandbox-a", "/notes.txt")
	if err != nil {
		t.Fatalf("exists failed: %v", err)
	}
	if !result.Exists || !result.IsFile {
		t.Fatalf("unexpected exists result: %+v", result)
	}

	contents, err := os.ReadFile(filepath.Join(root, "sandbox-a", "notes.txt"))
	if err != nil {
		t.Fatalf("failed reading file directly: %v", err)
	}
	if string(contents) != "hello" {
		t.Fatalf("unexpected file contents: %q", string(contents))
	}
}
