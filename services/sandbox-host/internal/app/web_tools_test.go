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

	"github.com/chiridion/sandbox-host/internal/state"
)

func TestWebToolFallbackUsesExaWhenFirecrawlFails(t *testing.T) {
	firecrawl := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, `{"error":"rate limited"}`, http.StatusTooManyRequests)
	}))
	defer firecrawl.Close()

	exa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/search" {
			t.Fatalf("unexpected exa path %s", r.URL.Path)
		}
		if got := r.Header.Get("x-api-key"); got != "exa-key" {
			t.Fatalf("x-api-key = %q, want exa-key", got)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"title":"Exa result","url":"https://example.com","highlights":["fallback worked"]}]}`))
	}))
	defer exa.Close()

	server := &Server{
		cfg: Config{
			FirecrawlAPIKey:  "firecrawl-key",
			FirecrawlBaseURL: firecrawl.URL,
			ExaAPIKey:        "exa-key",
			ExaBaseURL:       exa.URL,
			WebProviderOrder: "firecrawl,exa",
		},
		httpClient: exa.Client(),
	}

	text, result, err := server.executeWebTool(t.Context(), "search", map[string]any{"query": "test"}, "thread-1")
	if err != nil {
		t.Fatalf("executeWebTool() error = %v", err)
	}
	if result.Provider != webProviderExa {
		t.Fatalf("provider = %q, want %q", result.Provider, webProviderExa)
	}
	if !strings.Contains(text, "Exa result") || !strings.Contains(text, "fallback worked") {
		t.Fatalf("executeWebTool() text = %q", text)
	}
}

func TestWebSearchDoesNotRequestProviderContent(t *testing.T) {
	tests := []struct {
		name     string
		provider webProvider
		cfg      Config
		path     string
		assert   func(t *testing.T, body map[string]any)
	}{
		{
			name:     "firecrawl",
			provider: webProviderFirecrawl,
			cfg:      Config{FirecrawlAPIKey: "firecrawl-key", WebProviderOrder: "firecrawl"},
			path:     "/v2/search",
			assert: func(t *testing.T, body map[string]any) {
				if _, ok := body["scrapeOptions"]; ok {
					t.Fatalf("firecrawl search should not include scrapeOptions: %+v", body)
				}
			},
		},
		{
			name:     "parallel",
			provider: webProviderParallel,
			cfg:      Config{ParallelAPIKey: "parallel-key", WebProviderOrder: "parallel"},
			path:     "/v1/search",
			assert: func(t *testing.T, body map[string]any) {
				advanced, _ := body["advanced_settings"].(map[string]any)
				if _, ok := advanced["excerpt_settings"]; ok {
					t.Fatalf("parallel search should not include excerpt_settings: %+v", body)
				}
			},
		},
		{
			name:     "exa",
			provider: webProviderExa,
			cfg:      Config{ExaAPIKey: "exa-key", WebProviderOrder: "exa"},
			path:     "/search",
			assert: func(t *testing.T, body map[string]any) {
				if _, ok := body["contents"]; ok {
					t.Fatalf("exa search should not include contents: %+v", body)
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tt.path {
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
				raw, _ := io.ReadAll(r.Body)
				var body map[string]any
				if err := json.Unmarshal(raw, &body); err != nil {
					t.Fatalf("request body is not json: %v", err)
				}
				tt.assert(t, body)
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(`{"results":[{"title":"Result","url":"https://example.com","text":"body"}],"data":{"web":[{"title":"Result","url":"https://example.com","description":"body"}]}}`))
			}))
			defer provider.Close()

			cfg := tt.cfg
			cfg.FirecrawlBaseURL = provider.URL
			cfg.ParallelBaseURL = provider.URL
			cfg.ExaBaseURL = provider.URL
			server := &Server{cfg: cfg, httpClient: provider.Client()}
			if _, _, err := server.executeWebTool(t.Context(), "search", map[string]any{"query": "test", "content": "text"}, "thread-1"); err != nil {
				t.Fatalf("executeWebTool() error = %v", err)
			}
		})
	}
}

func TestWebSearchProvidersReturnUnifiedResults(t *testing.T) {
	tests := []struct {
		name     string
		cfg      Config
		path     string
		response string
	}{
		{
			name:     "firecrawl",
			cfg:      Config{FirecrawlAPIKey: "firecrawl-key", WebProviderOrder: "firecrawl"},
			path:     "/v2/search",
			response: `{"creditsUsed":2,"data":{"web":[{"title":"Result","url":"https://example.com","description":"metadata snippet","publishedDate":"2026-05-01","author":"Author"}]}}`,
		},
		{
			name:     "parallel",
			cfg:      Config{ParallelAPIKey: "parallel-key", WebProviderOrder: "parallel"},
			path:     "/v1/search",
			response: `{"usage":[{"name":"sku_search","count":1}],"results":[{"title":"Result","url":"https://example.com","excerpts":["metadata snippet"],"publish_date":"2026-05-01"}]}`,
		},
		{
			name:     "exa",
			cfg:      Config{ExaAPIKey: "exa-key", WebProviderOrder: "exa"},
			path:     "/search",
			response: `{"costDollars":{"total":0.007},"results":[{"title":"Result","url":"https://example.com","highlights":["metadata snippet"],"publishedDate":"2026-05-01","author":"Author"}]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tt.path {
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(tt.response))
			}))
			defer provider.Close()

			cfg := tt.cfg
			cfg.FirecrawlBaseURL = provider.URL
			cfg.ParallelBaseURL = provider.URL
			cfg.ExaBaseURL = provider.URL
			server := &Server{cfg: cfg, httpClient: provider.Client()}
			text, result, err := server.executeWebTool(t.Context(), "search", map[string]any{"query": "test"}, "thread-1")
			if err != nil {
				t.Fatalf("executeWebTool() error = %v", err)
			}
			if len(result.Results) != 1 {
				t.Fatalf("results = %+v, want one result", result.Results)
			}
			item := result.Results[0]
			if item.Title != "Result" || item.URL != "https://example.com" || !strings.Contains(item.Snippet, "metadata snippet") {
				t.Fatalf("result = %+v, want unified title/url/snippet", item)
			}
			if item.Text != "" {
				t.Fatalf("search result text = %q, want empty page text", item.Text)
			}
			if !strings.Contains(text, "Snippet: metadata snippet") {
				t.Fatalf("formatted text = %q, want snippet", text)
			}
		})
	}
}

func TestWebToolFetchUsesParallelExtract(t *testing.T) {
	parallel := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/extract" {
			t.Fatalf("unexpected parallel path %s", r.URL.Path)
		}
		if got := r.Header.Get("x-api-key"); got != "parallel-key" {
			t.Fatalf("x-api-key = %q, want parallel-key", got)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"results":[{"title":"Fetched page","url":"https://example.com/page","full_content":"page body"}],"errors":[]}`))
	}))
	defer parallel.Close()

	server := &Server{
		cfg: Config{
			ParallelAPIKey:   "parallel-key",
			ParallelBaseURL:  parallel.URL,
			WebProviderOrder: "parallel",
		},
		httpClient: parallel.Client(),
	}

	text, result, err := server.executeWebTool(t.Context(), "fetch", map[string]any{"url": "https://example.com/page"}, "thread-1")
	if err != nil {
		t.Fatalf("executeWebTool() error = %v", err)
	}
	if result.Provider != webProviderParallel {
		t.Fatalf("provider = %q, want %q", result.Provider, webProviderParallel)
	}
	if !strings.Contains(text, "Fetched page") || !strings.Contains(text, "page body") {
		t.Fatalf("executeWebTool() text = %q", text)
	}
}

func TestWebFetchProvidersReturnUnifiedResults(t *testing.T) {
	tests := []struct {
		name     string
		cfg      Config
		path     string
		response string
	}{
		{
			name:     "firecrawl",
			cfg:      Config{FirecrawlAPIKey: "firecrawl-key", WebProviderOrder: "firecrawl"},
			path:     "/v2/scrape",
			response: `{"data":{"title":"Fetched","metadata":{"sourceURL":"https://example.com/page","title":"Fetched"},"markdown":"page body"}}`,
		},
		{
			name:     "parallel",
			cfg:      Config{ParallelAPIKey: "parallel-key", WebProviderOrder: "parallel"},
			path:     "/v1/extract",
			response: `{"usage":[{"name":"sku_extract_excerpts","count":1}],"results":[{"title":"Fetched","url":"https://example.com/page","full_content":"page body"}],"errors":[]}`,
		},
		{
			name:     "exa",
			cfg:      Config{ExaAPIKey: "exa-key", WebProviderOrder: "exa"},
			path:     "/contents",
			response: `{"costDollars":{"total":0.001},"results":[{"title":"Fetched","url":"https://example.com/page","text":"page body"}]}`,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != tt.path {
					t.Fatalf("unexpected path %s", r.URL.Path)
				}
				w.Header().Set("content-type", "application/json")
				_, _ = w.Write([]byte(tt.response))
			}))
			defer provider.Close()

			cfg := tt.cfg
			cfg.FirecrawlBaseURL = provider.URL
			cfg.ParallelBaseURL = provider.URL
			cfg.ExaBaseURL = provider.URL
			server := &Server{cfg: cfg, httpClient: provider.Client()}
			text, result, err := server.executeWebTool(t.Context(), "fetch", map[string]any{"url": "https://example.com/page"}, "thread-1")
			if err != nil {
				t.Fatalf("executeWebTool() error = %v", err)
			}
			if len(result.Results) != 1 {
				t.Fatalf("results = %+v, want one result", result.Results)
			}
			item := result.Results[0]
			if item.URL != "https://example.com/page" || !strings.Contains(item.Text, "page body") {
				t.Fatalf("result = %+v, want unified url/text", item)
			}
			if !strings.Contains(text, "page body") {
				t.Fatalf("formatted text = %q, want page body", text)
			}
		})
	}
}

func TestWebToolCosts(t *testing.T) {
	if got := exaCostUSD(map[string]any{"costDollars": map[string]any{"total": 0.007}}); got != 0.007 {
		t.Fatalf("exaCostUSD() = %v, want 0.007", got)
	}
	if got := parallelUsageCostUSD(map[string]any{"usage": []any{map[string]any{"name": "sku_search", "count": float64(1)}, map[string]any{"name": "sku_extract_excerpts", "count": float64(2)}}}); got != 0.007 {
		t.Fatalf("parallelUsageCostUSD() = %v, want 0.007", got)
	}
}

func TestHostPiWebToolRecordsChargeableUsage(t *testing.T) {
	billing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/internal/billing/access" {
			t.Fatalf("unexpected billing path %s", r.URL.Path)
		}
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"org_id":"org-1","billing_status":"active","billing_credit_grant_total_cents":10000}`))
	}))
	defer billing.Close()

	exa := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"costDollars":{"total":0.007},"results":[{"title":"Result","url":"https://example.com","text":"body"}]}`))
	}))
	defer exa.Close()

	usage, err := state.NewUsageStore(filepath.Join(t.TempDir(), "usage"))
	if err != nil {
		t.Fatalf("new usage store: %v", err)
	}
	defer usage.Close()

	server := &Server{
		cfg: Config{
			ExaAPIKey:             "exa-key",
			ExaBaseURL:            exa.URL,
			WebProviderOrder:      "exa",
			WorkerBaseURL:         billing.URL,
			SandboxProxySecret:    "secret",
			ProxyThreadActiveTTL:  time.Hour,
			ProxyThreadCloseGrace: time.Minute,
		},
		proxyThreads: map[string]*ProxyThreadContext{
			"container::thread-1": {
				Key:           "container::thread-1",
				ContainerName: "container",
				OrgID:         "org-1",
				WorkspaceID:   "workspace-1",
				UserID:        "user-1",
				ThreadID:      "thread-1",
				WorkerBaseURL: billing.URL,
			},
		},
		hostPiChats: map[string]*hostPiBridge{
			"thread-1": {threadID: "thread-1", threadKey: "container::thread-1", askToken: "token"},
		},
		httpClient: exa.Client(),
		usage:      usage,
	}

	body, _ := json.Marshal(hostPiWebToolRequest{
		ThreadID: "thread-1",
		Token:    "token",
		Params:   map[string]any{"query": "test"},
	})
	req := httptest.NewRequest(http.MethodPost, "/internal/host-pi/web-search", bytes.NewReader(body))
	rec := httptest.NewRecorder()
	server.handleHostPiWebToolRoute(rec, req, "127.0.0.1", "search")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d body = %s", rec.Code, rec.Body.String())
	}

	deadline := time.Now().Add(2 * time.Second)
	for {
		sum, err := usage.GetCreditChargeableUsageLogSum("org-1", 0, time.Now().UnixMilli()+1)
		if err != nil {
			t.Fatalf("usage sum: %v", err)
		}
		if sum.TotalRequests == 1 && sum.TotalCostUSD == 0.007 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("usage not recorded, last sum = %+v", sum)
		}
		time.Sleep(10 * time.Millisecond)
	}
}
