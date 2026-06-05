package app

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
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
	headers.Set("X-Sandbox-Secret", "caller-secret")
	headers.Set("X-Chiridion-Thread-Id", "caller-thread")
	headers.Set("X-Test", "kept")

	copied := http.Header{}
	copyHeaders(copied, headers)
	if copied.Get("MF-Proxy-Shared-Secret") != "" {
		t.Fatal("expected copyHeaders to strip Miniflare proxy headers")
	}
	if copied.Get("X-Sandbox-Secret") != "" {
		t.Fatal("expected copyHeaders to strip sandbox proxy secret")
	}
	if copied.Get("X-Chiridion-Thread-Id") != "" {
		t.Fatal("expected copyHeaders to strip Chiridion identity headers")
	}
	if copied.Get("X-Test") != "kept" {
		t.Fatalf("expected normal copied header to be preserved, got %q", copied.Get("X-Test"))
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

func TestParseWorkspaceRouteWithThreadTokenScopedCloudflareProxy(t *testing.T) {
	route, ok := parseWorkspaceRoute("/v1/workspaces/org-1/ws-2/thread-tokens/signed-token/client/v4/accounts/acct")
	if !ok {
		t.Fatal("expected route to parse")
	}
	if route.OrgID != "org-1" || route.WorkspaceID != "ws-2" || route.ThreadToken != "signed-token" || route.Subpath != "/client/v4/accounts/acct" {
		t.Fatalf("unexpected route: %+v", route)
	}
}

func TestParseWorkspaceRouteRejectsNonProxyThreadTokenScopedRoute(t *testing.T) {
	if _, ok := parseWorkspaceRoute("/v1/workspaces/org-1/ws-2/thread-tokens/signed-token/fs/read"); ok {
		t.Fatal("expected non-proxy thread-token-scoped route to be rejected")
	}
}

func TestParseWorkspaceRouteRejectsLegacyThreadIdScopedRoute(t *testing.T) {
	if _, ok := parseWorkspaceRoute("/v1/workspaces/org-1/ws-2/threads/thread-3/client/v4/accounts/acct"); ok {
		t.Fatal("expected caller-controlled thread-id scoped route to be rejected")
	}
}

func TestHostPiInferenceRouteIsRemoved(t *testing.T) {
	server := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/internal/host-pi/inference/thread-1/api/openai/v1/responses", strings.NewReader(`{"model":"gpt-5.4","input":"hi"}`))
	req.RemoteAddr = "127.0.0.1:1234"
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusNotFound {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
	}
}

func TestVirtualAIRouteIsGone(t *testing.T) {
	server := &Server{}
	req := httptest.NewRequest(http.MethodPost, "/v1/virtual-ai/chat/completions", strings.NewReader(`{"model":"gpt-5.4-mini"}`))
	rec := httptest.NewRecorder()

	server.ServeHTTP(rec, req)

	if rec.Code != http.StatusGone {
		t.Fatalf("unexpected status: got=%d body=%s", rec.Code, rec.Body.String())
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

func TestForwardCloudflareAPIProxyRequest(t *testing.T) {
	threadToken := signedSandboxThreadScopeToken(t, "shared-secret", map[string]any{
		"org_id":       "org-1",
		"org_slug":     "org-1",
		"workspace_id": "ws-1",
		"thread_id":    "thread-1",
		"scopes":       []string{"sandbox_thread"},
		"exp":          time.Now().Add(time.Hour).UnixMilli(),
	})
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.URL.Path != "/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/app" {
			t.Fatalf("unexpected upstream path: %s", req.URL.Path)
		}
		if req.Header.Get("X-Sandbox-Secret") != "shared-secret" {
			t.Fatalf("missing sandbox secret header: %q", req.Header.Get("X-Sandbox-Secret"))
		}
		if req.Header.Get("X-Chiridion-Org-Id") != "org-1" {
			t.Fatalf("missing org forwarding header: %q", req.Header.Get("X-Chiridion-Org-Id"))
		}
		if req.Header.Get("X-Chiridion-Workspace-Id") != "ws-1" {
			t.Fatalf("missing workspace forwarding header: %q", req.Header.Get("X-Chiridion-Workspace-Id"))
		}
		if req.Header.Get("X-Chiridion-Thread-Id") != "thread-1" {
			t.Fatalf("missing trusted thread forwarding header: %q", req.Header.Get("X-Chiridion-Thread-Id"))
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			WorkerBaseURL:      upstream.URL,
			SandboxProxySecret: "shared-secret",
		},
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/workspaces/org-1/ws-1/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/app", nil)
	req.Header.Set("X-Chiridion-Thread-Id", "caller-spoofed-thread")
	rec := httptest.NewRecorder()
	route := WorkspaceRoute{
		OrgID:       "org-1",
		WorkspaceID: "ws-1",
		ThreadToken: threadToken,
		Subpath:     "/client/v4/accounts/acct/workers/dispatch/namespaces/ns/scripts/app",
	}

	if err := server.forwardCloudflareAPIProxyRequest(rec, req, route); err != nil {
		t.Fatalf("forwardCloudflareAPIProxyRequest failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusOK)
	}
	if got := rec.Body.String(); got != `{"success":true}` {
		t.Fatalf("unexpected body: %q", got)
	}
}

func TestForwardCloudflareAPIProxyRequestRejectsInvalidThreadToken(t *testing.T) {
	upstreamCalled := false
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		upstreamCalled = true
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			WorkerBaseURL:      upstream.URL,
			SandboxProxySecret: "shared-secret",
		},
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/workspaces/org-1/ws-1/client/v4/accounts/acct", nil)
	rec := httptest.NewRecorder()
	route := WorkspaceRoute{
		OrgID:       "org-1",
		WorkspaceID: "ws-1",
		ThreadToken: signedSandboxThreadScopeToken(t, "shared-secret", map[string]any{
			"org_id":       "org-1",
			"org_slug":     "org-1",
			"workspace_id": "other-workspace",
			"thread_id":    "thread-1",
			"scopes":       []string{"sandbox_thread"},
			"exp":          time.Now().Add(time.Hour).UnixMilli(),
		}),
		Subpath: "/client/v4/accounts/acct",
	}

	if err := server.forwardCloudflareAPIProxyRequest(rec, req, route); err != nil {
		t.Fatalf("forwardCloudflareAPIProxyRequest failed: %v", err)
	}
	if rec.Code != http.StatusForbidden {
		t.Fatalf("unexpected status: got=%d want=%d body=%s", rec.Code, http.StatusForbidden, rec.Body.String())
	}
	if upstreamCalled {
		t.Fatal("expected invalid token request not to reach upstream")
	}
}

func TestForwardCloudflareAPIProxyRequestStripsCallerThreadHeaderWhenRouteHasNoThread(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if req.Header.Get("X-Chiridion-Thread-Id") != "" {
			t.Fatalf("expected caller thread header to be stripped, got %q", req.Header.Get("X-Chiridion-Thread-Id"))
		}
		_, _ = w.Write([]byte(`{"success":true}`))
	}))
	defer upstream.Close()

	server := &Server{
		cfg: Config{
			WorkerBaseURL:      upstream.URL,
			SandboxProxySecret: "shared-secret",
		},
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}

	req := httptest.NewRequest(http.MethodGet, "/v1/workspaces/org-1/ws-1/client/v4/accounts/acct", nil)
	req.Header.Set("X-Chiridion-Thread-Id", "caller-spoofed-thread")
	rec := httptest.NewRecorder()
	route := WorkspaceRoute{
		OrgID:       "org-1",
		WorkspaceID: "ws-1",
		Subpath:     "/client/v4/accounts/acct",
	}

	if err := server.forwardCloudflareAPIProxyRequest(rec, req, route); err != nil {
		t.Fatalf("forwardCloudflareAPIProxyRequest failed: %v", err)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("unexpected status: got=%d want=%d", rec.Code, http.StatusOK)
	}
}

func signedSandboxThreadScopeToken(t *testing.T, secret string, payload map[string]any) string {
	t.Helper()
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("marshal token payload: %v", err)
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(payloadBytes)
	return "st_" +
		base64.RawURLEncoding.EncodeToString(payloadBytes) +
		"." +
		base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
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
