package app

import (
	"bytes"
	"context"
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

func TestHeaderCloningStripsMiniflareProxyHeaders(t *testing.T) {
	headers := http.Header{}
	headers.Set("MF-Proxy-Shared-Secret", "local-secret")
	headers.Set("X-Test", "kept")

	cloned := cloneHeaders(headers)
	if cloned.Get("MF-Proxy-Shared-Secret") != "" {
		t.Fatal("expected cloneHeaders to strip Miniflare proxy headers")
	}
	if cloned.Get("X-Test") != "kept" {
		t.Fatalf("expected normal header to be preserved, got %q", cloned.Get("X-Test"))
	}

	copied := http.Header{}
	copyHeaders(copied, headers)
	if copied.Get("MF-Proxy-Shared-Secret") != "" {
		t.Fatal("expected copyHeaders to strip Miniflare proxy headers")
	}
	if copied.Get("X-Test") != "kept" {
		t.Fatalf("expected normal copied header to be preserved, got %q", copied.Get("X-Test"))
	}
}

func TestDrainRouteTracksActiveHostPiTurns(t *testing.T) {
	server := &Server{hostPiChats: make(map[string]*hostPiBridge)}
	bridge := &hostPiBridge{threadID: "thread-1"}
	bridge.beginActiveTurn()
	server.hostPiChats["thread-1"] = bridge

	req := httptest.NewRequest(http.MethodPost, "/internal/admin/drain", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	rec := httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected drain status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	var status map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &status); err != nil {
		t.Fatalf("decode drain response: %v", err)
	}
	if draining, _ := status["draining"].(bool); !draining {
		t.Fatalf("expected draining=true, got %#v", status)
	}
	if active, _ := status["activePiTurns"].(float64); active != 1 {
		t.Fatalf("expected one active Pi turn, got %#v", status)
	}

	bridge.endActiveTurn()
	req = httptest.NewRequest(http.MethodDelete, "/internal/admin/drain", nil)
	req.RemoteAddr = "127.0.0.1:12345"
	rec = httptest.NewRecorder()
	server.ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected drain resume status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if server.IsDraining() {
		t.Fatal("expected drain mode to be disabled")
	}
}

func TestWaitForHostPiIdleWaitsUntilActiveTurnEnds(t *testing.T) {
	server := &Server{hostPiChats: make(map[string]*hostPiBridge)}
	bridge := &hostPiBridge{threadID: "thread-1"}
	bridge.beginActiveTurn()
	server.hostPiChats["thread-1"] = bridge

	go func() {
		time.Sleep(20 * time.Millisecond)
		bridge.endActiveTurn()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := server.WaitForHostPiIdle(ctx, time.Millisecond); err != nil {
		t.Fatalf("WaitForHostPiIdle() returned error: %v", err)
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

func TestParseHostPiInferenceRoute(t *testing.T) {
	proxy, ok := parseHostPiInferenceRoute("/internal/host-pi/inference/thread-123/api/openai/v1/responses")
	if !ok {
		t.Fatal("expected host Pi inference route to parse")
	}
	if proxy.ThreadID != "thread-123" {
		t.Fatalf("unexpected thread id: %s", proxy.ThreadID)
	}
	if proxy.UpstreamPath != "/api/openai/v1/responses" {
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

func TestHostPiInferenceRouteUsesThreadContextWithoutContainerCaller(t *testing.T) {
	var sawGatewayRequest bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		switch req.URL.Path {
		case "/api/internal/billing/access":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"org_id":"org-1","billing_status":"enterprise"}`))
		case "/openrouter/responses":
			sawGatewayRequest = true
			if got := req.Header.Get("cf-aig-authorization"); got != "Bearer test-token" {
				t.Fatalf("unexpected gateway auth header: %q", got)
			}
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"object":"response","model":"openai/gpt-5.4"}`))
		default:
			t.Fatalf("unexpected upstream path: %s", req.URL.Path)
		}
	}))
	defer upstream.Close()

	now := time.Now().UTC()
	threadKey := proxyThreadKey("test-container", "thread-1")
	server := &Server{
		cfg: Config{
			SandboxProxySecret:   "secret",
			AIGatewayBaseURL:     upstream.URL,
			AIGatewayToken:       "test-token",
			ProxyThreadActiveTTL: 5 * time.Minute,
		},
		containers:   container.NewTestManager(),
		httpClient:   upstream.Client(),
		proxyThreads: make(map[string]*ProxyThreadContext),
		hostPiChats:  make(map[string]*hostPiBridge),
	}
	closedAt := now.Add(-10 * time.Second)
	server.proxyThreads[threadKey] = &ProxyThreadContext{
		Key:           threadKey,
		ContainerName: "test-container",
		OrgID:         "org-1",
		WorkspaceID:   "ws-1",
		UserID:        "user-1",
		ThreadID:      "thread-1",
		WorkerBaseURL: upstream.URL,
		CreatedAt:     now.Add(-1 * time.Minute),
		LastSeenAt:    now.Add(-30 * time.Second),
		ExpiresAt:     now.Add(30 * time.Second),
		ClosedAt:      &closedAt,
	}
	server.hostPiChats["thread-1"] = &hostPiBridge{threadID: "thread-1", threadKey: threadKey}

	req := httptest.NewRequest(http.MethodPost, "/internal/host-pi/inference/thread-1/api/openai/v1/responses", strings.NewReader(`{"model":"gpt-5.4","input":"hi"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if !sawGatewayRequest {
		t.Fatal("expected request to reach gateway upstream")
	}
	if server.proxyThreads[threadKey].ClosedAt != nil {
		t.Fatal("expected host Pi loopback proxy to reopen the thread context")
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

func TestResolveVirtualAIModelUsesGeminiFlashForAuto(t *testing.T) {
	if got := resolveVirtualAIModel(""); got != "google/gemini-3-flash-preview" {
		t.Fatalf("resolveVirtualAIModel(empty) = %q", got)
	}
	if got := resolveVirtualAIModel("auto"); got != "google/gemini-3-flash-preview" {
		t.Fatalf("resolveVirtualAIModel(auto) = %q", got)
	}
	if got := resolveVirtualAIModel("dynamic/auto"); got != "google/gemini-3-flash-preview" {
		t.Fatalf("resolveVirtualAIModel(dynamic/auto) = %q", got)
	}
	if got := resolveVirtualAIModel("auto_search"); got != "dynamic/auto_search" {
		t.Fatalf("resolveVirtualAIModel(auto_search) = %q", got)
	}
	if got := resolveVirtualAIModel("google/gemini-3-flash-preview"); got != "google/gemini-3-flash-preview" {
		t.Fatalf("resolveVirtualAIModel(gemini) = %q", got)
	}
}

func TestForwardOpenAIToAIGatewayUsesOpenRouterResponsesPath(t *testing.T) {
	var capturedPath string
	var capturedModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		capturedModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"response","model":"openai/gpt-5.4","usage":{"input_tokens":1,"output_tokens":1}}`))
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
	if capturedPath != "/openrouter/responses" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/openrouter/responses")
	}
	if capturedModel != "gpt-5.4" {
		t.Fatalf("unexpected upstream model: got=%q want=%q", capturedModel, "gpt-5.4")
	}
}

func TestForwardClaudeToOpenRouterGatewayRewritesModel(t *testing.T) {
	var capturedPath string
	var capturedAuth string
	var capturedModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		capturedAuth = req.Header.Get("cf-aig-authorization")
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		capturedModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"type":"message","model":"anthropic/claude-sonnet-4.6","usage":{"input_tokens":1,"output_tokens":1}}`))
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

	body := `{"model":"sonnet","max_tokens":32,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/claude/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")

	rec := httptest.NewRecorder()
	server.forwardClaudeToOpenRouterGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/claude/v1/messages"}, testThreadContext(), testCaller(), "test-req-claude-openrouter-gateway", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/openrouter/v1/messages" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/openrouter/v1/messages")
	}
	if capturedAuth != "Bearer test-token" {
		t.Fatalf("unexpected gateway auth: got=%q", capturedAuth)
	}
	if capturedModel != "anthropic/claude-sonnet-4.6" {
		t.Fatalf("unexpected upstream model: got=%q want=%q", capturedModel, "anthropic/claude-sonnet-4.6")
	}
}

func TestForwardOpenAIToAIGatewayPreservesKimiModelAndRequestsStreamingUsage(t *testing.T) {
	var capturedPath string
	var capturedModel string
	var capturedIncludeUsage bool
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		capturedModel, _ = body["model"].(string)
		streamOptions, _ := body["stream_options"].(map[string]any)
		capturedIncludeUsage, _ = streamOptions["include_usage"].(bool)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_kimi","object":"chat.completion"}`))
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

	body := `{"model":"kimi-k2.6","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAIToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/chat/completions"}, testThreadContext(), testCaller(), "test-req-kimi-gateway", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/openrouter/chat/completions" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/openrouter/chat/completions")
	}
	if capturedModel != "kimi-k2.6" {
		t.Fatalf("unexpected upstream model: got=%q want=%q", capturedModel, "kimi-k2.6")
	}
	if !capturedIncludeUsage {
		t.Fatal("expected stream_options.include_usage to be injected for streaming chat completions")
	}
}

func TestForwardOpenAIToAIGatewayPreservesGrokModel(t *testing.T) {
	var capturedPath string
	var capturedModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		capturedModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"response","model":"x-ai/grok-4.3","usage":{"input_tokens":1,"output_tokens":1}}`))
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

	body := `{"model":"grok-4.3","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAIToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/responses"}, testThreadContext(), testCaller(), "test-req-grok-gateway", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/openrouter/responses" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/openrouter/responses")
	}
	if capturedModel != "grok-4.3" {
		t.Fatalf("unexpected upstream model: got=%q want=%q", capturedModel, "grok-4.3")
	}
}

func TestForwardOpenRouterEndpointToAIGateway(t *testing.T) {
	var capturedPath string
	var capturedModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		capturedModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"response","model":"openai/gpt-5.4","usage":{"input_tokens":1,"output_tokens":1}}`))
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

	body := `{"model":"openai/gpt-5.4","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openrouter/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAIToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openrouter/v1/responses"}, testThreadContext(), testCaller(), "test-req-openrouter-responses", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/openrouter/responses" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/openrouter/responses")
	}
	if capturedModel != "openai/gpt-5.4" {
		t.Fatalf("unexpected upstream model: got=%q want=%q", capturedModel, "openai/gpt-5.4")
	}
}

func TestForwardOpenAIToAIGatewayRecordsStreamingKimiUsage(t *testing.T) {
	usageStore, err := state.NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = usageStore.Close() }()

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join([]string{
			`data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"~moonshotai/kimi-latest","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}],"usage":null}`,
			"",
			`data: {"id":"gen-1","object":"chat.completion.chunk","created":1,"model":"~moonshotai/kimi-latest","choices":[],"usage":{"prompt_tokens":194,"prompt_tokens_details":{"cached_tokens":20,"cache_write_tokens":10},"completion_tokens":2,"total_tokens":196}}`,
			"",
			"data: [DONE]",
			"",
		}, "\n")))
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			AIGatewayBaseURL: upstream.URL,
			AIGatewayToken:   "test-token",
		},
		httpClient: &http.Client{},
		containers: container.NewTestManager(),
		usage:      usageStore,
	}

	body := `{"model":"kimi-k2.6","stream":true,"messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAIToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/chat/completions"}, testThreadContext(), testCaller(), "test-req-kimi-stream-usage", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}

	var entries []state.UsageLogEntry
	for range 20 {
		entries, err = usageStore.GetUsageLog("test-org", 20)
		if err != nil {
			t.Fatalf("read usage log: %v", err)
		}
		if len(entries) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(entries) != 1 {
		t.Fatalf("expected one usage row, got %+v", entries)
	}
	if entries[0].Model != "~moonshotai/kimi-latest" {
		t.Fatalf("unexpected usage model: got=%q", entries[0].Model)
	}
	if entries[0].Provider != "openrouter" {
		t.Fatalf("unexpected usage provider: got=%q", entries[0].Provider)
	}
	if entries[0].InputTokens != 164 || entries[0].CacheReadInputTokens != 20 || entries[0].CacheCreationInputTokens != 10 || entries[0].OutputTokens != 2 {
		t.Fatalf("unexpected usage tokens: %+v", entries[0])
	}
}

func TestEnsureOpenAIStreamingUsagePreservesExistingOptions(t *testing.T) {
	raw := []byte(`{"model":"gpt-5.4","stream":true,"stream_options":{"foo":"bar"},"messages":[{"role":"user","content":"hi"}]}`)
	next := ensureOpenAIStreamingUsage(raw, "/chat/completions")

	var body map[string]any
	if err := json.Unmarshal(next, &body); err != nil {
		t.Fatalf("decode rewritten body: %v", err)
	}
	streamOptions, _ := body["stream_options"].(map[string]any)
	if streamOptions == nil {
		t.Fatal("expected stream_options to be present")
	}
	if streamOptions["foo"] != "bar" {
		t.Fatalf("expected existing stream option to be preserved, got %#v", streamOptions)
	}
	if includeUsage, _ := streamOptions["include_usage"].(bool); !includeUsage {
		t.Fatalf("expected include_usage=true, got %#v", streamOptions["include_usage"])
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

func TestForwardOpenAICompatibleDirectPreservesModelForOpenRouter(t *testing.T) {
	var capturedAuth string
	var capturedModel string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedAuth = req.Header.Get("Authorization")
		var body map[string]any
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
			t.Fatalf("decode upstream body: %v", err)
		}
		capturedModel, _ = body["model"].(string)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_or","object":"chat.completion"}`))
	}))
	defer upstream.Close()

	server := &Server{
		httpClient: &http.Client{},
		containers: container.NewTestManager(),
	}

	body := `{"model":"kimi-k2.6","messages":[{"role":"user","content":"hi"}]}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	server.forwardOpenAICompatibleDirect(
		rec,
		req,
		ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/chat/completions"},
		testThreadContext(),
		testCaller(),
		"test-req-openrouter-direct",
		time.Now(),
		upstream.URL+"/api",
		"test-openrouter-key",
		"openrouter",
	)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedAuth != "Bearer test-openrouter-key" {
		t.Fatalf("unexpected auth header: got=%q", capturedAuth)
	}
	if capturedModel != "kimi-k2.6" {
		t.Fatalf("unexpected upstream model: got=%q want=%q", capturedModel, "kimi-k2.6")
	}
}

func TestForwardOpenAIDirectUsesV1ResponsesPath(t *testing.T) {
	var capturedPath string
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"object":"response","model":"gpt-5.4","usage":{"input_tokens":1,"output_tokens":1}}`))
	}))
	defer upstream.Close()

	server := &Server{
		httpClient: upstream.Client(),
		containers: container.NewTestManager(),
	}

	originalTransport := server.httpClient.Transport
	server.httpClient.Transport = roundTripperFunc(func(req *http.Request) (*http.Response, error) {
		req.URL.Scheme = "https"
		req.URL.Host = strings.TrimPrefix(upstream.URL, "https://")
		return originalTransport.RoundTrip(req)
	})

	body := `{"model":"gpt-5.4","input":"hi"}`
	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/responses", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	thread := testThreadContext()
	thread.ByokOpenAIKey = "test-openai-key"
	server.forwardOpenAIDirect(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/responses"}, thread, testCaller(), "test-req-openai-direct-responses", time.Now())

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/v1/responses" {
		t.Fatalf("unexpected upstream path: got=%q want=%q", capturedPath, "/v1/responses")
	}
}

type roundTripperFunc func(*http.Request) (*http.Response, error)

func (fn roundTripperFunc) RoundTrip(req *http.Request) (*http.Response, error) {
	return fn(req)
}

func TestVirtualAIProxyRecordsCreditChargeableUsage(t *testing.T) {
	usageStore, err := state.NewUsageStore(t.TempDir())
	if err != nil {
		t.Fatalf("open usage store: %v", err)
	}
	defer func() { _ = usageStore.Close() }()

	billingServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/api/internal/billing/access" {
			t.Fatalf("unexpected billing path: %s", req.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{
			"org_id":"org-1",
			"billing_status":"active",
			"billing_credit_purchase_total_cents":1000,
			"billing_credit_grant_total_cents":0
		}`))
	}))
	defer billingServer.Close()

	var capturedPath string
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		capturedPath = req.URL.Path
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"chatcmpl_1","object":"chat.completion","model":"gpt-5.4-mini","usage":{"prompt_tokens":1000,"completion_tokens":2000}}`))
	}))
	defer gateway.Close()

	server := &Server{
		cfg: Config{
			AIGatewayBaseURL: gateway.URL,
			AIGatewayToken:   "test-gateway-token",
			WorkerBaseURL:    billingServer.URL,
		},
		httpClient: &http.Client{},
		usage:      usageStore,
	}

	req := httptest.NewRequest(http.MethodPost, "/v1/virtual-ai/chat/completions", strings.NewReader(`{
		"model":"gpt-5.4-mini",
		"messages":[{"role":"user","content":"hello"}]
	}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-chiridion-org-id", "org-1")
	req.Header.Set("x-chiridion-workspace-id", "ws-1")
	req.Header.Set("x-chiridion-user-id", "user-1")

	rec := httptest.NewRecorder()
	server.handleVirtualAIRoute(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
	if capturedPath != "/openrouter/chat/completions" {
		t.Fatalf("unexpected gateway path: got=%q want=%q", capturedPath, "/openrouter/chat/completions")
	}

	var sum state.UsageLogSum
	for i := 0; i < 20; i++ {
		sum, err = usageStore.GetCreditChargeableUsageLogSum("org-1", 0, time.Now().Add(time.Minute).UnixMilli())
		if err != nil {
			t.Fatalf("read chargeable usage: %v", err)
		}
		if sum.TotalRequests == 1 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if sum.TotalRequests != 1 {
		t.Fatalf("expected 1 chargeable request, got %d", sum.TotalRequests)
	}
	if sum.TotalInputTokens != 1000 || sum.TotalOutputTokens != 2000 {
		t.Fatalf("unexpected token sum: %+v", sum)
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
