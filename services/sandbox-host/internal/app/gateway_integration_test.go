package app

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/chiridion/sandbox-host/internal/container"
)

// Integration tests for AI Gateway forwarding.
// Requires real credentials — skipped when env vars are absent.
//
// Run:
//   CF_ACCOUNT_ID=... CF_GATEWAY_NAME=... CF_GATEWAY_TOKEN=... \
//     go test -run TestGateway -v -count=1 ./internal/app/

func gatewayTestServer(t *testing.T) *Server {
	t.Helper()
	accountID := os.Getenv("CF_ACCOUNT_ID")
	gatewayName := os.Getenv("CF_GATEWAY_NAME")
	gatewayToken := os.Getenv("CF_GATEWAY_TOKEN")

	if accountID == "" || gatewayName == "" || gatewayToken == "" {
		t.Skip("Skipping: CF_ACCOUNT_ID, CF_GATEWAY_NAME, CF_GATEWAY_TOKEN required")
	}

	cfg := Config{
		AIGatewayBaseURL: "https://gateway.ai.cloudflare.com/v1/" + accountID + "/" + gatewayName,
		AIGatewayToken:   gatewayToken,
		AWSRegionName:    "us-west-2",
		TraceSandboxHost: true,
	}

	return &Server{
		cfg:          cfg,
		containers:   container.NewTestManager(),
		httpClient:   &http.Client{Timeout: 120 * time.Second},
		proxyThreads: make(map[string]*ProxyThreadContext),
	}
}

func testThreadContext() *ProxyThreadContext {
	return &ProxyThreadContext{
		Key:           "test-container::test-thread",
		ContainerName: "test-container",
		OrgID:         "test-org",
		WorkspaceID:   "test-ws",
		ThreadID:      "test-thread",
	}
}

func testCaller() *container.ContainerRecord {
	return &container.ContainerRecord{Name: "test-container"}
}

func TestGatewayClaudeNonStreaming(t *testing.T) {
	s := gatewayTestServer(t)

	body := `{
		"model": "claude-sonnet-4-20250514",
		"max_tokens": 32,
		"messages": [{"role": "user", "content": "Say hello in exactly 3 words."}]
	}`

	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/claude/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")

	rec := httptest.NewRecorder()
	s.forwardClaudeToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/claude/v1/messages"}, testThreadContext(), testCaller(), "test-req-1", time.Now())

	resp := rec.Result()
	respBody, _ := io.ReadAll(resp.Body)
	t.Logf("Status: %d", resp.StatusCode)
	t.Logf("cf-aig-step: %s", resp.Header.Get("cf-aig-step"))
	t.Logf("Body: %s", string(respBody))

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]any
	if err := json.Unmarshal(respBody, &result); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
	if result["type"] != "message" {
		t.Fatalf("unexpected response type: %v", result["type"])
	}
	t.Logf("Provider step: %s (0=Bedrock primary, 1=Anthropic fallback)", resp.Header.Get("cf-aig-step"))
}

func TestGatewayClaudeStreaming(t *testing.T) {
	s := gatewayTestServer(t)

	body := `{
		"model": "claude-sonnet-4-20250514",
		"max_tokens": 32,
		"stream": true,
		"messages": [{"role": "user", "content": "Say hello in exactly 3 words."}]
	}`

	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/claude/v1/messages", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")

	rec := httptest.NewRecorder()
	s.forwardClaudeToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/claude/v1/messages"}, testThreadContext(), testCaller(), "test-req-2", time.Now())

	resp := rec.Result()
	respBody, _ := io.ReadAll(resp.Body)
	t.Logf("Status: %d", resp.StatusCode)
	t.Logf("cf-aig-step: %s", resp.Header.Get("cf-aig-step"))
	t.Logf("Content-Type: %s", resp.Header.Get("Content-Type"))
	t.Logf("Body (first 500 chars): %.500s", string(respBody))

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, string(respBody))
	}

	bodyStr := string(respBody)
	// Whether Bedrock (converted) or Anthropic (native), we should see SSE events
	if !strings.Contains(bodyStr, "event:") && !strings.Contains(bodyStr, "data:") {
		t.Fatalf("expected SSE events in response body, got: %.500s", bodyStr)
	}
	t.Logf("Provider step: %s (0=Bedrock primary, 1=Anthropic fallback)", resp.Header.Get("cf-aig-step"))
}

func TestGatewayClaudeCountTokens(t *testing.T) {
	s := gatewayTestServer(t)

	body := `{
		"model": "claude-sonnet-4-20250514",
		"messages": [{"role": "user", "content": "Hello world"}]
	}`

	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/claude/v1/messages/count_tokens", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("anthropic-version", "2023-06-01")

	rec := httptest.NewRecorder()
	s.forwardClaudeToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/claude/v1/messages/count_tokens"}, testThreadContext(), testCaller(), "test-req-3", time.Now())

	resp := rec.Result()
	respBody, _ := io.ReadAll(resp.Body)
	t.Logf("Status: %d", resp.StatusCode)
	t.Logf("Body: %s", string(respBody))

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", resp.StatusCode, string(respBody))
	}

	// count_tokens should go to Anthropic only (no Bedrock fallback)
	step := resp.Header.Get("cf-aig-step")
	t.Logf("Provider step: %s (should be 0 = Anthropic-only)", step)
}

func TestGatewayOpenAI(t *testing.T) {
	s := gatewayTestServer(t)

	body := `{
		"model": "auto",
		"max_tokens": 32,
		"messages": [{"role": "user", "content": "Say hello in exactly 3 words."}]
	}`

	req := httptest.NewRequest(http.MethodPost, "/proxy/test-thread/api/openai/v1/chat/completions", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")

	rec := httptest.NewRecorder()
	s.forwardOpenAIToAIGateway(rec, req, ProxyRoute{ThreadID: "test-thread", UpstreamPath: "/api/openai/v1/chat/completions"}, testThreadContext(), testCaller(), "test-req-4", time.Now())

	resp := rec.Result()
	respBody, _ := io.ReadAll(resp.Body)
	t.Logf("Status: %d", resp.StatusCode)
	t.Logf("Content-Type: %s", resp.Header.Get("Content-Type"))
	t.Logf("Body: %s", string(respBody))

	// 401 = BYOK for OpenAI not configured in gateway dashboard
	// 200 = BYOK configured and working
	if resp.StatusCode == 401 {
		t.Logf("OpenAI returned 401 — gateway BYOK for OpenAI not configured (expected in dev)")
		return
	}
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 or 401, got %d: %s", resp.StatusCode, string(respBody))
	}

	var result map[string]any
	if err := json.Unmarshal(respBody, &result); err != nil {
		t.Fatalf("response is not valid JSON: %v", err)
	}
}
