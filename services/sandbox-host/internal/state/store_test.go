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
	container := ContainerRecord{
		Name:              "sandbox-a",
		ContainerID:       "abc123",
		HostPort:          18080,
		ContainerIP:       "172.17.0.2",
		Status:            "running",
		CreatedAt:         now.Add(-time.Minute),
		LastAccessedAt:    now,
		ActiveWebSockets:  1,
		InFlightProxyReqs: 2,
		OrgID:             "org-1",
		WorkspaceID:       "ws-1",
	}
	if err := store.UpsertContainer(container); err != nil {
		t.Fatalf("upsert container: %v", err)
	}

	containers, err := store.LoadContainers()
	if err != nil {
		t.Fatalf("load containers: %v", err)
	}
	if len(containers) != 1 {
		t.Fatalf("expected 1 container, got %d", len(containers))
	}
	if containers[0].Name != container.Name || containers[0].HostPort != container.HostPort {
		t.Fatalf("unexpected container record: %+v", containers[0])
	}

	thread := ProxyThreadRecord{
		Key:           "sandbox-a::thread-1",
		ContainerName: "sandbox-a",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
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

	terminated := TerminatedWorkspaceRecord{
		Name:         "sandbox-a",
		TerminatedAt: now,
	}
	if err := store.UpsertTerminatedWorkspace(terminated); err != nil {
		t.Fatalf("upsert terminated workspace: %v", err)
	}
	terminatedRows, err := store.LoadTerminatedWorkspaces()
	if err != nil {
		t.Fatalf("load terminated workspaces: %v", err)
	}
	if len(terminatedRows) != 1 || terminatedRows[0].Name != terminated.Name {
		t.Fatalf("unexpected terminated rows: %+v", terminatedRows)
	}

	if err := store.DeleteProxyThread(thread.Key); err != nil {
		t.Fatalf("delete proxy thread: %v", err)
	}
	if err := store.DeleteContainer(container.Name); err != nil {
		t.Fatalf("delete container: %v", err)
	}
	if err := store.DeleteTerminatedWorkspace(terminated.Name); err != nil {
		t.Fatalf("delete terminated workspace: %v", err)
	}

	threads, err = store.LoadProxyThreads()
	if err != nil {
		t.Fatalf("reload proxy threads: %v", err)
	}
	if len(threads) != 0 {
		t.Fatalf("expected no proxy threads, got %d", len(threads))
	}
	containers, err = store.LoadContainers()
	if err != nil {
		t.Fatalf("reload containers: %v", err)
	}
	if len(containers) != 0 {
		t.Fatalf("expected no containers, got %d", len(containers))
	}
	terminatedRows, err = store.LoadTerminatedWorkspaces()
	if err != nil {
		t.Fatalf("reload terminated workspaces: %v", err)
	}
	if len(terminatedRows) != 0 {
		t.Fatalf("expected no terminated rows, got %d", len(terminatedRows))
	}
}
