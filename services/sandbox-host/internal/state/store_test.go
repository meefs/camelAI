package state

import (
	"path/filepath"
	"testing"
	"time"
)

func TestStoreRoundTripAndDelete(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")
	store, err := Open(dbPath)
	if err != nil {
		t.Fatalf("open state store: %v", err)
	}
	defer func() { _ = store.Close() }()

	now := time.Now().UTC().Truncate(time.Millisecond)

	thread := ProxyThreadRecord{
		Key:           "sandbox-a::thread-1",
		ContainerName: "sandbox-a",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
		UserID:        "user-1",
		ThreadID:      "thread-1",
		WorkerBaseURL: "https://worker.example.com",
		CreatedAt:     now,
		LastSeenAt:    now,
		ExpiresAt:     now.Add(time.Minute),
	}
	if err := store.UpsertProxyThread(thread); err != nil {
		t.Fatalf("upsert proxy thread: %v", err)
	}
	threads, err := store.LoadProxyThreads()
	if err != nil {
		t.Fatalf("load proxy threads: %v", err)
	}
	if len(threads) != 1 || threads[0].Key != thread.Key {
		t.Fatalf("unexpected proxy threads: %+v", threads)
	}
	if threads[0].UserID != "user-1" {
		t.Fatalf("unexpected user id: %+v", threads[0])
	}

	if err := store.DeleteProxyThread(thread.Key); err != nil {
		t.Fatalf("delete proxy thread: %v", err)
	}

	threads, err = store.LoadProxyThreads()
	if err != nil {
		t.Fatalf("reload proxy threads: %v", err)
	}
	if len(threads) != 0 {
		t.Fatalf("expected no proxy threads, got %d", len(threads))
	}
}
