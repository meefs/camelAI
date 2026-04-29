package app

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/chiridion/sandbox-host/internal/container"
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

func TestRewriteClaudeRequestBodyForOpenRouter(t *testing.T) {
	body := []byte(`{"model":"sonnet","messages":[{"role":"user","content":"hi"}],"max_tokens":100}`)
	rewritten := rewriteClaudeRequestBodyForOpenRouter(body)

	var parsed map[string]any
	if err := json.Unmarshal(rewritten, &parsed); err != nil {
		t.Fatalf("rewritten body is not json: %v", err)
	}
	if parsed["model"] != "anthropic/claude-sonnet-4.6" {
		t.Fatalf("unexpected model rewrite: %v", parsed["model"])
	}

	alreadyOpenRouter := []byte(`{"model":"anthropic/claude-haiku-4.5"}`)
	if string(rewriteClaudeRequestBodyForOpenRouter(alreadyOpenRouter)) != string(alreadyOpenRouter) {
		t.Fatal("expected explicit OpenRouter model to be preserved")
	}

	snapshotModel := []byte(`{"model":"claude-haiku-4-5-20251001"}`)
	var snapshotParsed map[string]any
	if err := json.Unmarshal(rewriteClaudeRequestBodyForOpenRouter(snapshotModel), &snapshotParsed); err != nil {
		t.Fatalf("rewritten snapshot body is not json: %v", err)
	}
	if snapshotParsed["model"] != "anthropic/claude-haiku-4.5" {
		t.Fatalf("unexpected snapshot model rewrite: %v", snapshotParsed["model"])
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
	open := state.ProxyThreadRecord{
		Key:           "sandbox-a::thread-open",
		ContainerName: "sandbox-a",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
		ThreadID:      "thread-open",
		WorkerBaseURL: "https://worker.example.com",
		CreatedAt:     now.Add(-2 * time.Minute),
		LastSeenAt:    now.Add(-1 * time.Minute),
		ExpiresAt:     now.Add(2 * time.Minute),
	}
	closedGrace := state.ProxyThreadRecord{
		Key:           "sandbox-a::thread-closed",
		ContainerName: "sandbox-a",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
		ThreadID:      "thread-closed",
		WorkerBaseURL: "https://worker.example.com",
		CreatedAt:     now.Add(-3 * time.Minute),
		LastSeenAt:    now.Add(-30 * time.Second),
		ExpiresAt:     now.Add(90 * time.Second),
		ClosedAt:      ptrTime(now.Add(-10 * time.Second)),
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
		ClosedAt:      ptrTime(now.Add(-2 * time.Minute)),
	}

	if err := store.UpsertProxyThread(open); err != nil {
		t.Fatalf("upsert open thread: %v", err)
	}
	if err := store.UpsertProxyThread(closedGrace); err != nil {
		t.Fatalf("upsert closed grace thread: %v", err)
	}
	if err := store.UpsertProxyThread(expired); err != nil {
		t.Fatalf("upsert expired thread: %v", err)
	}

	server := &Server{
		state:        store,
		proxyThreads: make(map[string]*ProxyThreadContext),
	}
	server.loadProxyThreadsFromState()

	if _, ok := server.proxyThreads[closedGrace.Key]; !ok {
		t.Fatalf("expected closed-grace proxy thread %q to be restored", closedGrace.Key)
	}
	if _, ok := server.proxyThreads[open.Key]; !ok {
		t.Fatalf("expected open proxy thread %q to be restored", open.Key)
	}
	if _, ok := server.proxyThreads[expired.Key]; ok {
		t.Fatalf("did not expect expired proxy thread %q to be restored", expired.Key)
	}

	records, err := store.LoadProxyThreads()
	if err != nil {
		t.Fatalf("load proxy threads after hydration: %v", err)
	}
	if len(records) != 2 {
		t.Fatalf("expected open + closed-grace threads to remain persisted, got: %+v", records)
	}
	recordKeys := map[string]bool{}
	for _, record := range records {
		recordKeys[record.Key] = true
	}
	if !recordKeys[open.Key] || !recordKeys[closedGrace.Key] || recordKeys[expired.Key] {
		t.Fatalf("unexpected persisted record keys: %+v", recordKeys)
	}
}

func ptrTime(v time.Time) *time.Time {
	return &v
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

func TestShouldPreserveAuthorization(t *testing.T) {
	if !shouldPreserveAuthorization("/client/v4/accounts/chiridion/workers/assets/upload") {
		t.Fatal("expected assets upload path to preserve Authorization")
	}
	if shouldPreserveAuthorization("/client/v4/accounts/chiridion/workers/dispatch/namespaces/ns/scripts/app") {
		t.Fatal("did not expect dispatch script path to preserve Authorization")
	}
	if shouldPreserveAuthorization("/api/claude/v1/messages") {
		t.Fatal("did not expect non-CF path to preserve Authorization")
	}
}

func TestForwardDataProxyRequest(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/data-proxy/postgres/query" {
			t.Fatalf("unexpected upstream path: %s", req.URL.Path)
		}
		if req.Header.Get("X-Chiridion-Org-Id") != "org-1" {
			t.Fatalf("missing org forwarding header: %q", req.Header.Get("X-Chiridion-Org-Id"))
		}
		if req.Header.Get("X-Chiridion-Workspace-Id") != "ws-1" {
			t.Fatalf("missing workspace forwarding header: %q", req.Header.Get("X-Chiridion-Workspace-Id"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"recordset":[{"value":1}]}`))
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{DataProxyUpstreamURL: upstream.URL},
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/workspaces/org-1/ws-1/data-proxy/postgres/query", strings.NewReader(`{"query":"select 1"}`))
	rec := httptest.NewRecorder()
	route := WorkspaceRoute{
		OrgID:       "org-1",
		WorkspaceID: "ws-1",
		Subpath:     "/data-proxy/postgres/query",
	}

	if err := server.forwardDataProxyRequest(rec, req, route); err != nil {
		t.Fatalf("forwardDataProxyRequest failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != `{"recordset":[{"value":1}]}` {
		t.Fatalf("unexpected body: %q", got)
	}
}

func TestShouldUseGatewayOpenAIResponses(t *testing.T) {
	if !shouldUseGatewayOpenAIResponses("/responses", "gpt-5.4") {
		t.Fatal("expected gpt-* responses traffic to use openai provider")
	}
	if !shouldUseGatewayOpenAIResponses("/responses", "GPT-5.4-mini") {
		t.Fatal("expected case-insensitive gpt-* detection")
	}
	if shouldUseGatewayOpenAIResponses("/chat/completions", "gpt-5.4") {
		t.Fatal("did not expect chat completions to use openai responses provider")
	}
	if shouldUseGatewayOpenAIResponses("/responses", "dynamic/auto") {
		t.Fatal("did not expect dynamic aliases to use openai responses provider")
	}
	if shouldUseGatewayOpenAIResponses("/responses", "anthropic/claude-sonnet-4.6") {
		t.Fatal("did not expect non-OpenAI model IDs to use openai responses provider")
	}
}

func TestForwardOpenAIToAIGatewayUsesOpenAIResponsesForGPTModels(t *testing.T) {
	var capturedPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"response","model":"gpt-5.4","usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			AIGatewayBaseURL: upstream.URL,
			AIGatewayToken:   "test-token",
		},
		httpClient: &http.Client{},
		containers: container.NewTestManager(),
	}

	body := `{"model":"gpt-5.4","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAIToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/responses"}, testThreadContext(), testCaller(), "test-req-openai-responses", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/openai/responses" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/openai/responses")
	}
}

func TestForwardOpenAICompatibleDirectPreservesV1ResponsesPath(t *testing.T) {
	var capturedPath string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"resp-test","object":"response"}`))
	}))
	defer upstream.Close()

	server := &Server{
		httpClient: &http.Client{},
		containers: container.NewTestManager(),
	}

	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/responses", strings.NewReader(`{"model":"gpt-5.4","input":"hi"}`))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAICompatibleDirect(
		rec,
		req,
		ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/responses"},
		testThreadContext(),
		testCaller(),
		"test-req-byok-openrouter",
		time.Now(),
		upstream.URL+"/api",
		"sk-test",
		"openrouter",
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/api/v1/responses" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/api/v1/responses")
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
