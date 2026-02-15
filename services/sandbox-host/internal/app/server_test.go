package app

import (
	"bytes"
	"io"
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/chiridion/sandbox-host/internal/state"
)

func TestSandboxNameNormalization(t *testing.T) {
	got := sandboxName("Workspace_ABC/..//Name")
	want := "chiridion-ws-workspace-abc-name"
	if got != want {
		t.Fatalf("sandboxName mismatch: got %q want %q", got, want)
	}
}

func TestParseWorkspaceRoute(t *testing.T) {
	route, ok := parseWorkspaceRoute("/v1/workspaces/org-1/ws-2/fs/read")
	if !ok {
		t.Fatal("expected route to parse")
	}
	if route.OrgID != "org-1" || route.WorkspaceID != "ws-2" || route.Subpath != "/fs/read" {
		t.Fatalf("unexpected route: %+v", route)
	}
	if route.Name != "chiridion-ws-ws-2" {
		t.Fatalf("unexpected sandbox name: %s", route.Name)
	}
}

func TestParseProxyRoute(t *testing.T) {
	proxy, ok := parseProxyRoute("/proxy/thread-123/api/claude/v1/messages")
	if !ok {
		t.Fatal("expected proxy route to parse")
	}
	if proxy.ThreadID != "thread-123" {
		t.Fatalf("unexpected thread id: %s", proxy.ThreadID)
	}
	if proxy.UpstreamPath != "/api/claude/v1/messages" {
		t.Fatalf("unexpected upstream path: %s", proxy.UpstreamPath)
	}
}

func TestNormalizeWorkerBaseURL(t *testing.T) {
	got := normalizeWorkerBaseURL("https://example.com/a/b?x=1#frag")
	if got != "https://example.com" {
		t.Fatalf("unexpected normalized URL: %q", got)
	}

	if normalizeWorkerBaseURL("ftp://example.com") != "" {
		t.Fatal("expected unsupported scheme to return empty")
	}
}

func TestLoadProxyThreadsFromState(t *testing.T) {
	dbPath := filepath.Join(t.TempDir(), "state.db")
	store, err := state.Open(dbPath)
	if err != nil {
		t.Fatalf("open state store: %v", err)
	}
	defer func() { _ = store.Close() }()

	now := time.Now().UTC()
	active := state.ProxyThreadRecord{
		Key:           "sandbox-a::thread-active",
		ContainerName: "sandbox-a",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
		ThreadID:      "thread-active",
		WorkerBaseURL: "https://worker.example.com",
		CreatedAt:     now.Add(-2 * time.Minute),
		LastSeenAt:    now.Add(-1 * time.Minute),
		ExpiresAt:     now.Add(2 * time.Minute),
	}
	expired := state.ProxyThreadRecord{
		Key:           "sandbox-a::thread-expired",
		ContainerName: "sandbox-a",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
		ThreadID:      "thread-expired",
		WorkerBaseURL: "https://worker.example.com",
		CreatedAt:     now.Add(-5 * time.Minute),
		LastSeenAt:    now.Add(-4 * time.Minute),
		ExpiresAt:     now.Add(-1 * time.Minute),
	}

	if err := store.UpsertProxyThread(active); err != nil {
		t.Fatalf("upsert active thread: %v", err)
	}
	if err := store.UpsertProxyThread(expired); err != nil {
		t.Fatalf("upsert expired thread: %v", err)
	}

	server := &Server{
		state:        store,
		proxyThreads: make(map[string]*ProxyThreadContext),
	}
	server.loadProxyThreadsFromState()

	if _, ok := server.proxyThreads[active.Key]; !ok {
		t.Fatalf("expected active proxy thread %q to be restored", active.Key)
	}
	if _, ok := server.proxyThreads[expired.Key]; ok {
		t.Fatalf("expected expired proxy thread %q to be skipped", expired.Key)
	}

	records, err := store.LoadProxyThreads()
	if err != nil {
		t.Fatalf("load proxy threads after hydration: %v", err)
	}
	if len(records) != 1 || records[0].Key != active.Key {
		t.Fatalf("expected only active thread to remain persisted, got: %+v", records)
	}
}

func TestApplyStreamingRequestHeaders(t *testing.T) {
	headers := http.Header{}
	applyStreamingRequestHeaders(headers)

	if got := headers.Get("Accept-Encoding"); got != "identity" {
		t.Fatalf("unexpected Accept-Encoding: %q", got)
	}
	if got := headers.Get("Cache-Control"); got != "no-cache, no-transform" {
		t.Fatalf("unexpected Cache-Control: %q", got)
	}
	if got := headers.Get("Pragma"); got != "no-cache" {
		t.Fatalf("unexpected Pragma: %q", got)
	}
}

func TestApplyStreamingResponseHeaders(t *testing.T) {
	headers := http.Header{}
	applyStreamingResponseHeaders(headers, "text/event-stream; charset=utf-8")

	if got := headers.Get("Cache-Control"); got != "no-cache, no-transform" {
		t.Fatalf("unexpected Cache-Control: %q", got)
	}
	if got := headers.Get("X-Accel-Buffering"); got != "no" {
		t.Fatalf("unexpected X-Accel-Buffering: %q", got)
	}
}

func TestApplyStreamingResponseHeadersNonStreaming(t *testing.T) {
	headers := http.Header{}
	applyStreamingResponseHeaders(headers, "application/json")

	if got := headers.Get("X-Accel-Buffering"); got != "" {
		t.Fatalf("expected no accel buffering header, got %q", got)
	}
}

func TestCopyResponseBodyFlushes(t *testing.T) {
	writer := &testResponseWriter{header: make(http.Header)}
	body := &chunkReader{
		chunks: [][]byte{
			[]byte("abc"),
			[]byte("def"),
		},
	}

	if err := copyResponseBody(writer, body); err != nil {
		t.Fatalf("copyResponseBody failed: %v", err)
	}

	if got := writer.body.String(); got != "abcdef" {
		t.Fatalf("unexpected body: %q", got)
	}
	if writer.flushCount < 2 {
		t.Fatalf("expected at least 2 flushes, got %d", writer.flushCount)
	}
}

func TestIsLoopbackSourceIP(t *testing.T) {
	if !isLoopbackSourceIP("127.0.0.1") {
		t.Fatal("expected IPv4 loopback to be detected")
	}
	if !isLoopbackSourceIP("::1") {
		t.Fatal("expected IPv6 loopback to be detected")
	}
	if !isLoopbackSourceIP("::ffff:127.0.0.1") {
		t.Fatal("expected mapped IPv4 loopback to be detected")
	}
	if isLoopbackSourceIP("172.17.0.2") {
		t.Fatal("did not expect non-loopback address to pass")
	}
}

type chunkReader struct {
	chunks [][]byte
	index  int
}

func (r *chunkReader) Read(p []byte) (int, error) {
	if r.index >= len(r.chunks) {
		return 0, io.EOF
	}
	chunk := r.chunks[r.index]
	r.index++
	n := copy(p, chunk)
	return n, nil
}

type testResponseWriter struct {
	header     http.Header
	body       bytes.Buffer
	statusCode int
	flushCount int
}

func (w *testResponseWriter) Header() http.Header {
	return w.header
}

func (w *testResponseWriter) Write(p []byte) (int, error) {
	return w.body.Write(p)
}

func (w *testResponseWriter) WriteHeader(statusCode int) {
	w.statusCode = statusCode
}

func (w *testResponseWriter) Flush() {
	w.flushCount++
}
