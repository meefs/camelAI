package app

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/chiridion/sandbox-host/internal/state"
)

type webProvider string

const (
	webProviderFirecrawl webProvider = "firecrawl"
	webProviderParallel  webProvider = "parallel"
	webProviderExa       webProvider = "exa"
)

type webToolContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type webResult struct {
	Title         string `json:"title,omitempty"`
	URL           string `json:"url,omitempty"`
	PublishedDate string `json:"publishedDate,omitempty"`
	Author        string `json:"author,omitempty"`
	Snippet       string `json:"snippet,omitempty"`
	Text          string `json:"text,omitempty"`
}

type webProviderResult struct {
	Provider webProvider
	Results  []webResult
	CostUSD  float64
}

func (s *Server) handleHostPiWebToolRoute(w http.ResponseWriter, req *http.Request, sourceIP string, operation string) {
	if req.Method != http.MethodPost {
		errorJSON(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !isLoopbackSourceIP(sourceIP) {
		errorJSON(w, "Host Pi web endpoint is loopback only", http.StatusForbidden)
		return
	}

	var body hostPiWebToolRequest
	if err := decodeJSON(req, &body); err != nil {
		errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.ThreadID) == "" {
		errorJSON(w, "threadId required", http.StatusBadRequest)
		return
	}

	bridge := s.hostPiBridgeForThread(body.ThreadID)
	if bridge == nil {
		errorJSON(w, "Host Pi chat session not found", http.StatusNotFound)
		return
	}
	if body.Token == "" || body.Token != bridge.askToken {
		errorJSON(w, "Invalid Host Pi token", http.StatusForbidden)
		return
	}

	threadContext := s.copyProxyThreadContextByKey(bridge.threadKey)
	billingDecision := BillingAccessDecision{BillingSource: billingSourceHosted}
	if threadContext != nil {
		billingDecision = s.checkOrgBillingAccess(threadContext, billingSourceHosted, "web_"+operation)
		if billingDecision.Denied {
			errorJSON(w, billingDecision.Message, billingDecision.StatusCode)
			return
		}
	}

	startedAt := time.Now()
	text, providerResult, err := s.executeWebTool(req.Context(), operation, body.Params, body.ThreadID)
	if err != nil {
		errorJSON(w, err.Error(), http.StatusBadGateway)
		return
	}
	if threadContext != nil {
		go s.recordWebUsage(
			threadContext,
			string(providerResult.Provider),
			billingDecision.BillingSource,
			billingDecision.CreditChargeable,
			"web_"+operation,
			providerResult.CostUSD,
			time.Since(startedAt).Milliseconds(),
		)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"content":  []webToolContent{{Type: "text", Text: text}},
		"costUSD":  providerResult.CostUSD,
		"provider": string(providerResult.Provider),
		"results":  providerResult.Results,
	})
}

func (s *Server) executeWebTool(ctx context.Context, operation string, params map[string]any, threadID string) (string, webProviderResult, error) {
	if params == nil {
		params = map[string]any{}
	}
	ctx, cancel := context.WithTimeout(ctx, 35*time.Second)
	defer cancel()

	switch operation {
	case "search":
		query := strings.TrimSpace(stringParam(params, "query"))
		if query == "" {
			return "", webProviderResult{}, errors.New("query is required")
		}
		numResults := clampWebInt(params["numResults"], 5, 1, 10)
		maxChars := clampWebInt(params["maxCharacters"], 1200, 200, 8000)
		result, err := s.withWebProviderFallback(ctx, operation, func(provider webProvider) (webProviderResult, error) {
			return s.webSearchWithProvider(ctx, provider, params, threadID, query, numResults, maxChars)
		})
		if err != nil {
			return "", webProviderResult{}, err
		}
		return formatWebResults(result.Results, maxChars, fmt.Sprintf("No results found for %s.", query)), result, nil
	case "fetch":
		targetURL := strings.TrimSpace(stringParam(params, "url"))
		if targetURL == "" {
			return "", webProviderResult{}, errors.New("url is required")
		}
		maxChars := clampWebInt(params["maxCharacters"], 12000, 500, 30000)
		result, err := s.withWebProviderFallback(ctx, operation, func(provider webProvider) (webProviderResult, error) {
			return s.webFetchWithProvider(ctx, provider, params, threadID, targetURL, maxChars)
		})
		if err != nil {
			return "", webProviderResult{}, err
		}
		return formatWebResults(result.Results, maxChars, fmt.Sprintf("No content returned for %s.", targetURL)), result, nil
	default:
		return "", webProviderResult{}, fmt.Errorf("unsupported web operation %q", operation)
	}
}

func (s *Server) withWebProviderFallback(ctx context.Context, operation string, call func(webProvider) (webProviderResult, error)) (webProviderResult, error) {
	providers := s.rotatedWebProviders()
	if len(providers) == 0 {
		return webProviderResult{}, errors.New("no web provider API keys are configured")
	}

	var failures []string
	for _, provider := range providers {
		result, err := call(provider)
		if err == nil {
			return result, nil
		}
		failures = append(failures, fmt.Sprintf("%s: %v", provider, err))
		if ctx.Err() != nil {
			break
		}
	}
	return webProviderResult{}, fmt.Errorf("%s failed for all web providers: %s", operation, strings.Join(failures, "; "))
}

func (s *Server) rotatedWebProviders() []webProvider {
	ordered := s.configuredWebProviders()
	if len(ordered) <= 1 {
		return ordered
	}
	s.webToolMu.Lock()
	start := s.webToolIndex % len(ordered)
	s.webToolIndex++
	s.webToolMu.Unlock()

	out := append([]webProvider{}, ordered[start:]...)
	out = append(out, ordered[:start]...)
	return out
}

func (s *Server) configuredWebProviders() []webProvider {
	defaults := []webProvider{webProviderFirecrawl, webProviderParallel, webProviderExa}
	var preferred []webProvider
	for _, raw := range strings.Split(s.cfg.WebProviderOrder, ",") {
		switch webProvider(strings.ToLower(strings.TrimSpace(raw))) {
		case webProviderFirecrawl:
			preferred = append(preferred, webProviderFirecrawl)
		case webProviderParallel:
			preferred = append(preferred, webProviderParallel)
		case webProviderExa:
			preferred = append(preferred, webProviderExa)
		}
	}
	for _, provider := range defaults {
		if !containsWebProvider(preferred, provider) {
			preferred = append(preferred, provider)
		}
	}

	out := make([]webProvider, 0, len(preferred))
	for _, provider := range preferred {
		if containsWebProvider(out, provider) || !s.webProviderConfigured(provider) {
			continue
		}
		out = append(out, provider)
	}
	return out
}

func containsWebProvider(providers []webProvider, needle webProvider) bool {
	for _, provider := range providers {
		if provider == needle {
			return true
		}
	}
	return false
}

func (s *Server) webProviderConfigured(provider webProvider) bool {
	switch provider {
	case webProviderFirecrawl:
		return strings.TrimSpace(s.cfg.FirecrawlAPIKey) != ""
	case webProviderParallel:
		return strings.TrimSpace(s.cfg.ParallelAPIKey) != ""
	case webProviderExa:
		return strings.TrimSpace(s.cfg.ExaAPIKey) != ""
	default:
		return false
	}
}

func (s *Server) copyProxyThreadContextByKey(threadKey string) *ProxyThreadContext {
	threadKey = strings.TrimSpace(threadKey)
	if threadKey == "" {
		return nil
	}
	s.proxyMu.Lock()
	defer s.proxyMu.Unlock()
	return copyProxyThreadContext(s.proxyThreads[threadKey])
}

func (s *Server) recordWebUsage(tc *ProxyThreadContext, provider string, billingSource string, creditChargeable bool, model string, costUSD float64, durationMs int64) {
	if tc == nil {
		return
	}
	record := state.UsageRecord{
		OrgID:            tc.OrgID,
		WorkspaceID:      tc.WorkspaceID,
		UserID:           tc.UserID,
		ThreadID:         tc.ThreadID,
		Model:            model,
		Provider:         provider,
		BillingSource:    billingSource,
		CreditChargeable: creditChargeable,
		CostUSD:          costUSD,
		DurationMs:       durationMs,
	}
	if err := s.usage.RecordUsage(record); err != nil {
		log.Printf("[SandboxHost] failed to record web usage org=%s thread=%s model=%s provider=%s cost=%.6f error=%v",
			tc.OrgID, tc.ThreadID, model, provider, costUSD, err)
		return
	}
	s.trace("web_usage_recorded", map[string]any{
		"orgId":            tc.OrgID,
		"workspaceId":      tc.WorkspaceID,
		"threadId":         tc.ThreadID,
		"userId":           tc.UserID,
		"model":            model,
		"provider":         provider,
		"billingSource":    billingSource,
		"creditChargeable": creditChargeable,
		"costUSD":          costUSD,
		"durationMs":       durationMs,
	})
}

func (s *Server) webSearchWithProvider(ctx context.Context, provider webProvider, params map[string]any, threadID, query string, numResults, maxChars int) (webProviderResult, error) {
	switch provider {
	case webProviderFirecrawl:
		return s.firecrawlSearch(ctx, params, query, numResults, maxChars)
	case webProviderParallel:
		return s.parallelSearch(ctx, params, threadID, query, numResults, maxChars)
	case webProviderExa:
		return s.exaSearch(ctx, params, query, numResults, maxChars)
	default:
		return webProviderResult{}, fmt.Errorf("unknown provider %q", provider)
	}
}

func (s *Server) webFetchWithProvider(ctx context.Context, provider webProvider, params map[string]any, threadID, targetURL string, maxChars int) (webProviderResult, error) {
	switch provider {
	case webProviderFirecrawl:
		return s.firecrawlFetch(ctx, params, targetURL, maxChars)
	case webProviderParallel:
		return s.parallelFetch(ctx, params, threadID, targetURL, maxChars)
	case webProviderExa:
		return s.exaFetch(ctx, params, targetURL, maxChars)
	default:
		return webProviderResult{}, fmt.Errorf("unknown provider %q", provider)
	}
}

func (s *Server) firecrawlSearch(ctx context.Context, params map[string]any, query string, numResults, maxChars int) (webProviderResult, error) {
	includeDomains := normalizeWebDomains(params["includeDomains"])
	excludeDomains := normalizeWebDomains(params["excludeDomains"])
	body := map[string]any{
		"query":             firecrawlQuery(query, includeDomains, excludeDomains, params["category"]),
		"limit":             numResults,
		"sources":           firecrawlSources(params["category"]),
		"ignoreInvalidURLs": true,
		"timeout":           30000,
	}
	if categories := firecrawlCategories(params["category"]); len(categories) > 0 {
		body["categories"] = categories
	}
	if tbs := firecrawlTimeFilter(params["startPublishedDate"], params["endPublishedDate"]); tbs != "" {
		body["tbs"] = tbs
	}

	payload, err := s.webJSON(ctx, webProviderFirecrawl, s.cfg.FirecrawlBaseURL+"/v2/search", map[string]string{
		"authorization": "Bearer " + s.cfg.FirecrawlAPIKey,
	}, body)
	if err != nil {
		return webProviderResult{}, err
	}
	results := make([]webResult, 0)
	for _, entry := range firecrawlEntries(payload) {
		if result, ok := normalizeFirecrawlResult(entry, false); ok {
			results = append(results, result)
		}
	}
	return webProviderResult{
		Provider: webProviderFirecrawl,
		Results:  truncateWebResults(filterWebDomains(results, includeDomains, excludeDomains), numResults, maxChars),
		CostUSD:  0.005,
	}, nil
}

func (s *Server) firecrawlFetch(ctx context.Context, params map[string]any, targetURL string, maxChars int) (webProviderResult, error) {
	maxAge := 172800000
	if boolParam(params, "fresh") {
		maxAge = 0
	}
	payload, err := s.webJSON(ctx, webProviderFirecrawl, s.cfg.FirecrawlBaseURL+"/v2/scrape", map[string]string{
		"authorization": "Bearer " + s.cfg.FirecrawlAPIKey,
	}, map[string]any{
		"url":             targetURL,
		"formats":         []string{"markdown"},
		"onlyMainContent": true,
		"timeout":         30000,
		"maxAge":          maxAge,
	})
	if err != nil {
		return webProviderResult{}, err
	}
	data, _ := payload["data"].(map[string]any)
	if data == nil {
		data = payload
	}
	data["url"] = targetURL
	result, ok := normalizeFirecrawlResult(data, true)
	if !ok {
		return webProviderResult{Provider: webProviderFirecrawl, CostUSD: 0.001}, nil
	}
	return webProviderResult{
		Provider: webProviderFirecrawl,
		Results:  truncateWebResults([]webResult{result}, 1, maxChars),
		CostUSD:  0.001,
	}, nil
}

func (s *Server) parallelSearch(ctx context.Context, params map[string]any, threadID, query string, numResults, maxChars int) (webProviderResult, error) {
	includeDomains := normalizeWebDomains(params["includeDomains"])
	excludeDomains := normalizeWebDomains(params["excludeDomains"])
	sourcePolicy := map[string]any{}
	if len(includeDomains) > 0 {
		sourcePolicy["include_domains"] = includeDomains
	}
	if len(excludeDomains) > 0 {
		sourcePolicy["exclude_domains"] = excludeDomains
	}
	if afterDate := dateOnly(params["startPublishedDate"]); afterDate != "" {
		sourcePolicy["after_date"] = afterDate
	}
	advanced := map[string]any{"max_results": numResults}
	if len(sourcePolicy) > 0 {
		advanced["source_policy"] = sourcePolicy
	}
	body := map[string]any{
		"objective":         query,
		"search_queries":    []string{query},
		"mode":              parallelMode(params["searchType"]),
		"max_chars_total":   maxInt(1000, numResults*maxChars),
		"session_id":        threadID,
		"advanced_settings": advanced,
	}
	payload, err := s.webJSON(ctx, webProviderParallel, s.cfg.ParallelBaseURL+"/v1/search", map[string]string{
		"x-api-key": s.cfg.ParallelAPIKey,
	}, body)
	if err != nil {
		return webProviderResult{}, err
	}
	costUSD := parallelUsageCostUSD(payload)
	if costUSD <= 0 {
		costUSD = 0.005
	}
	return webProviderResult{
		Provider: webProviderParallel,
		Results:  truncateWebResults(filterWebDomains(normalizeParallelResults(payload["results"], false), includeDomains, excludeDomains), numResults, maxChars),
		CostUSD:  costUSD,
	}, nil
}

func (s *Server) parallelFetch(ctx context.Context, params map[string]any, threadID, targetURL string, maxChars int) (webProviderResult, error) {
	objective := strings.TrimSpace(stringParam(params, "query"))
	if objective == "" {
		objective = "Extract the main content from " + targetURL + "."
	}
	maxAgeSeconds := 172800
	if boolParam(params, "fresh") {
		maxAgeSeconds = 600
	}
	payload, err := s.webJSON(ctx, webProviderParallel, s.cfg.ParallelBaseURL+"/v1/extract", map[string]string{
		"x-api-key": s.cfg.ParallelAPIKey,
	}, map[string]any{
		"urls":            []string{targetURL},
		"objective":       objective,
		"max_chars_total": maxChars,
		"session_id":      threadID,
		"advanced_settings": map[string]any{
			"fetch_policy": map[string]any{
				"max_age_seconds":        maxAgeSeconds,
				"timeout_seconds":        30,
				"disable_cache_fallback": false,
			},
			"excerpt_settings": map[string]any{"max_chars_per_result": maxInt(1000, minInt(maxChars, 30000))},
			"full_content":     map[string]any{"max_chars_per_result": maxChars},
		},
	})
	if err != nil {
		return webProviderResult{}, err
	}
	costUSD := parallelUsageCostUSD(payload)
	if costUSD <= 0 {
		costUSD = 0.001
	}
	results := normalizeParallelResults(payload["results"], true)
	if len(results) > 0 {
		return webProviderResult{
			Provider: webProviderParallel,
			Results:  truncateWebResults(results, 1, maxChars),
			CostUSD:  costUSD,
		}, nil
	}
	if errorsList, ok := payload["errors"].([]any); ok && len(errorsList) > 0 {
		return webProviderResult{}, fmt.Errorf("parallel extract returned errors")
	}
	return webProviderResult{Provider: webProviderParallel, CostUSD: costUSD}, nil
}

func (s *Server) exaSearch(ctx context.Context, params map[string]any, query string, numResults, maxChars int) (webProviderResult, error) {
	body := map[string]any{
		"query":      query,
		"type":       defaultString(stringParam(params, "searchType"), "auto"),
		"numResults": numResults,
	}
	if category := stringParam(params, "category"); category != "" {
		body["category"] = category
	}
	if start := strings.TrimSpace(stringParam(params, "startPublishedDate")); start != "" {
		body["startPublishedDate"] = start
	}
	if end := strings.TrimSpace(stringParam(params, "endPublishedDate")); end != "" {
		body["endPublishedDate"] = end
	}
	if includeDomains := normalizeWebDomains(params["includeDomains"]); len(includeDomains) > 0 {
		body["includeDomains"] = includeDomains
	}
	if excludeDomains := normalizeWebDomains(params["excludeDomains"]); len(excludeDomains) > 0 {
		body["excludeDomains"] = excludeDomains
	}
	payload, err := s.webJSON(ctx, webProviderExa, s.cfg.ExaBaseURL+"/search", map[string]string{
		"x-api-key": s.cfg.ExaAPIKey,
	}, body)
	if err != nil {
		return webProviderResult{}, err
	}
	costUSD := exaCostUSD(payload)
	if costUSD <= 0 {
		costUSD = 0.007
	}
	return webProviderResult{
		Provider: webProviderExa,
		Results:  truncateWebResults(normalizeExaResults(payload["results"], false), numResults, maxChars),
		CostUSD:  costUSD,
	}, nil
}

func (s *Server) exaFetch(ctx context.Context, params map[string]any, targetURL string, maxChars int) (webProviderResult, error) {
	body := map[string]any{
		"urls":             []string{targetURL},
		"livecrawl":        "fallback",
		"livecrawlTimeout": 15000,
	}
	if boolParam(params, "fresh") {
		body["livecrawl"] = "always"
	}
	switch stringParam(params, "content") {
	case "highlights":
		highlights := map[string]any{"numSentences": 4, "highlightsPerUrl": 5}
		if query := strings.TrimSpace(stringParam(params, "query")); query != "" {
			highlights["query"] = query
		}
		body["highlights"] = highlights
	case "summary":
		summary := map[string]any{}
		if query := strings.TrimSpace(stringParam(params, "query")); query != "" {
			summary["query"] = query
		}
		body["summary"] = summary
	default:
		body["text"] = map[string]any{"maxCharacters": maxChars}
	}
	payload, err := s.webJSON(ctx, webProviderExa, s.cfg.ExaBaseURL+"/contents", map[string]string{
		"x-api-key": s.cfg.ExaAPIKey,
	}, body)
	if err != nil {
		return webProviderResult{}, err
	}
	costUSD := exaCostUSD(payload)
	if costUSD <= 0 {
		costUSD = 0.001
	}
	return webProviderResult{
		Provider: webProviderExa,
		Results:  truncateWebResults(normalizeExaResults(payload["results"], true), 1, maxChars),
		CostUSD:  costUSD,
	}, nil
}

func (s *Server) webJSON(ctx context.Context, provider webProvider, target string, headers map[string]string, body map[string]any) (map[string]any, error) {
	encoded, err := json.Marshal(body)
	if err != nil {
		return nil, err
	}
	requestCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(requestCtx, http.MethodPost, target, bytes.NewReader(encoded))
	if err != nil {
		return nil, err
	}
	req.Header.Set("content-type", "application/json")
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	payload := map[string]any{}
	if len(bytes.TrimSpace(raw)) > 0 {
		if err := json.Unmarshal(raw, &payload); err != nil {
			payload["message"] = string(raw)
		}
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("%s request failed with HTTP %d: %s", provider, resp.StatusCode, webPayloadMessage(payload))
	}
	if success, ok := payload["success"].(bool); ok && !success {
		return nil, fmt.Errorf("%s request failed: %s", provider, webPayloadMessage(payload))
	}
	return payload, nil
}

func parallelUsageCostUSD(payload map[string]any) float64 {
	entries, ok := payload["usage"].([]any)
	if !ok {
		return 0
	}
	var total float64
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		count, ok := webNumber(item["count"])
		if !ok {
			count = 1
		}
		switch strings.TrimSpace(fmt.Sprint(item["name"])) {
		case "sku_search":
			total += count * 0.005
		case "sku_extract_excerpts", "sku_extract_full_content":
			total += count * 0.001
		}
	}
	return total
}

func exaCostUSD(payload map[string]any) float64 {
	cost, ok := payload["costDollars"].(map[string]any)
	if !ok {
		return 0
	}
	if total, ok := webNumber(cost["total"]); ok {
		return total
	}
	return 0
}

func webNumber(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case float32:
		return float64(typed), true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	case json.Number:
		parsed, err := typed.Float64()
		return parsed, err == nil
	case string:
		parsed, err := strconv.ParseFloat(strings.TrimSpace(typed), 64)
		return parsed, err == nil
	default:
		return 0, false
	}
}

func webPayloadMessage(payload map[string]any) string {
	if msg, ok := payload["error"].(string); ok && strings.TrimSpace(msg) != "" {
		return strings.TrimSpace(msg)
	}
	if errObj, ok := payload["error"].(map[string]any); ok {
		if msg, ok := errObj["message"].(string); ok && strings.TrimSpace(msg) != "" {
			return strings.TrimSpace(msg)
		}
	}
	if msg, ok := payload["message"].(string); ok && strings.TrimSpace(msg) != "" {
		return strings.TrimSpace(msg)
	}
	return "unknown error"
}

func normalizeFirecrawlResult(entry any, includeContent bool) (webResult, bool) {
	item, ok := entry.(map[string]any)
	if !ok {
		return webResult{}, false
	}
	metadata, _ := item["metadata"].(map[string]any)
	targetURL := webFirstString(item, "url", "sourceURL")
	if targetURL == "" {
		targetURL = webFirstString(metadata, "sourceURL", "url")
	}
	if targetURL == "" {
		return webResult{}, false
	}
	result := webResult{
		Title:         defaultString(webFirstString(item, "title"), webFirstString(metadata, "title", "ogTitle")),
		URL:           targetURL,
		PublishedDate: defaultString(webFirstString(item, "publishedDate", "published_date", "date"), webFirstString(metadata, "publishedDate", "publishedTime", "date")),
		Author:        defaultString(webFirstString(item, "author"), webFirstString(metadata, "author")),
		Snippet:       firstContent(item, "description", "snippet"),
	}
	if includeContent {
		result.Text = firstContent(item, "markdown", "text", "summary", "content")
		if result.Text == "" {
			result.Text = result.Snippet
		}
	}
	return result, true
}

func firecrawlEntries(payload map[string]any) []any {
	if entries, ok := payload["data"].([]any); ok {
		return entries
	}
	data, ok := payload["data"].(map[string]any)
	if !ok {
		return nil
	}
	var out []any
	for _, key := range []string{"web", "news", "images"} {
		if entries, ok := data[key].([]any); ok {
			out = append(out, entries...)
		}
	}
	return out
}

func normalizeParallelResults(value any, includeContent bool) []webResult {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	results := make([]webResult, 0, len(entries))
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		targetURL := webFirstString(item, "url")
		if targetURL == "" {
			continue
		}
		snippet := firstContent(item, "description", "snippet", "excerpts")
		text := ""
		if includeContent {
			text = defaultString(contentString(item["full_content"]), contentString(item["excerpts"]))
		}
		results = append(results, webResult{
			Title:         webFirstString(item, "title"),
			URL:           targetURL,
			PublishedDate: webFirstString(item, "publish_date", "publishedDate", "published_date"),
			Snippet:       snippet,
			Text:          text,
		})
	}
	return results
}

func normalizeExaResults(value any, includeContent bool) []webResult {
	entries, ok := value.([]any)
	if !ok {
		return nil
	}
	results := make([]webResult, 0, len(entries))
	for _, entry := range entries {
		item, ok := entry.(map[string]any)
		if !ok {
			continue
		}
		targetURL := webFirstString(item, "url")
		if targetURL == "" {
			continue
		}
		snippet := firstContent(item, "snippet", "description", "highlights")
		text := ""
		if includeContent {
			text = firstContent(item, "text", "summary", "highlights")
		}
		results = append(results, webResult{
			Title:         webFirstString(item, "title"),
			URL:           targetURL,
			PublishedDate: webFirstString(item, "publishedDate"),
			Author:        webFirstString(item, "author"),
			Snippet:       snippet,
			Text:          text,
		})
	}
	return results
}

func formatWebResults(results []webResult, maxChars int, empty string) string {
	if len(results) == 0 {
		return empty
	}
	parts := make([]string, 0, len(results))
	for i, result := range results {
		title := strings.TrimSpace(result.Title)
		if title == "" {
			title = "Untitled"
		}
		lines := []string{fmt.Sprintf("%d. %s", i+1, title)}
		if result.URL != "" {
			lines = append(lines, "URL: "+result.URL)
		}
		if result.PublishedDate != "" {
			lines = append(lines, "Published: "+result.PublishedDate)
		}
		if result.Author != "" {
			lines = append(lines, "Author: "+result.Author)
		}
		if snippet := truncateWebText(result.Snippet, maxChars); snippet != "" {
			lines = append(lines, "Snippet: "+snippet)
		}
		if text := truncateWebText(result.Text, maxChars); text != "" {
			lines = append(lines, "", text)
		}
		parts = append(parts, strings.Join(lines, "\n"))
	}
	return strings.Join(parts, "\n\n")
}

func truncateWebResults(results []webResult, limit, maxChars int) []webResult {
	if limit > 0 && len(results) > limit {
		results = results[:limit]
	}
	for i := range results {
		results[i].Snippet = truncateWebText(results[i].Snippet, maxChars)
		results[i].Text = truncateWebText(results[i].Text, maxChars)
	}
	return results
}

func truncateWebText(text string, maxChars int) string {
	text = strings.TrimSpace(text)
	if text == "" || len(text) <= maxChars {
		return text
	}
	return fmt.Sprintf("%s\n\n[Truncated: %d of %d characters]", text[:maxChars], maxChars, len(text))
}

func filterWebDomains(results []webResult, includeDomains, excludeDomains []string) []webResult {
	filtered := make([]webResult, 0, len(results))
	for _, result := range results {
		parsed, err := url.Parse(result.URL)
		if err != nil || parsed.Hostname() == "" {
			continue
		}
		hostname := strings.ToLower(parsed.Hostname())
		if len(includeDomains) > 0 && !anyDomainMatches(hostname, includeDomains) {
			continue
		}
		if anyDomainMatches(hostname, excludeDomains) {
			continue
		}
		filtered = append(filtered, result)
	}
	return filtered
}

func anyDomainMatches(hostname string, domains []string) bool {
	for _, domain := range domains {
		normalized := strings.Trim(strings.ToLower(domain), ".")
		if hostname == normalized || strings.HasSuffix(hostname, "."+normalized) {
			return true
		}
	}
	return false
}

func normalizeWebDomains(value any) []string {
	raw, ok := value.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, minInt(len(raw), 20))
	for _, entry := range raw {
		domain := strings.TrimSpace(fmt.Sprint(entry))
		if domain == "" {
			continue
		}
		if !strings.Contains(domain, "://") {
			domain = "https://" + domain
		}
		if parsed, err := url.Parse(domain); err == nil && parsed.Hostname() != "" {
			domain = parsed.Hostname()
		}
		domain = strings.Trim(domain, ".")
		if domain != "" {
			out = append(out, domain)
		}
		if len(out) >= 20 {
			break
		}
	}
	return out
}

func firecrawlQuery(query string, includeDomains, excludeDomains []string, category any) string {
	parts := []string{query}
	if stringParam(map[string]any{"category": category}, "category") == "pdf" {
		parts = append(parts, "filetype:pdf")
	}
	if len(includeDomains) == 1 {
		parts = append(parts, "site:"+includeDomains[0])
	}
	for _, domain := range excludeDomains {
		parts = append(parts, "-site:"+domain)
	}
	return strings.Join(parts, " ")
}

func firecrawlCategories(category any) []string {
	switch strings.TrimSpace(fmt.Sprint(category)) {
	case "github":
		return []string{"github"}
	case "pdf":
		return []string{"pdf"}
	case "research paper":
		return []string{"research"}
	default:
		return nil
	}
}

func firecrawlSources(category any) []string {
	if strings.TrimSpace(fmt.Sprint(category)) == "news" {
		return []string{"web", "news"}
	}
	return []string{"web"}
}

var webDatePattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})`)

func dateOnly(value any) string {
	match := webDatePattern.FindStringSubmatch(strings.TrimSpace(fmt.Sprint(value)))
	if len(match) == 4 {
		return match[0]
	}
	return ""
}

func firecrawlTimeFilter(startValue, endValue any) string {
	start := dateOnly(startValue)
	end := dateOnly(endValue)
	if start == "" && end == "" {
		return ""
	}
	parts := []string{"cdr:1"}
	if start != "" {
		parts = append(parts, "cd_min:"+firecrawlDate(start))
	}
	if end != "" {
		parts = append(parts, "cd_max:"+firecrawlDate(end))
	}
	return strings.Join(parts, ",")
}

func firecrawlDate(date string) string {
	parts := strings.Split(date, "-")
	if len(parts) != 3 {
		return date
	}
	return parts[1] + "/" + parts[2] + "/" + parts[0]
}

func parallelMode(value any) string {
	if strings.TrimSpace(fmt.Sprint(value)) == "fast" {
		return "basic"
	}
	return "advanced"
}

func stringParam(params map[string]any, key string) string {
	value, ok := params[key]
	if !ok || value == nil {
		return ""
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fmt.Sprint(value)
}

func boolParam(params map[string]any, key string) bool {
	value, ok := params[key]
	if !ok {
		return false
	}
	typed, ok := value.(bool)
	return ok && typed
}

func clampWebInt(value any, fallback, minValue, maxValue int) int {
	number := fallback
	switch typed := value.(type) {
	case float64:
		number = int(typed)
	case int:
		number = typed
	case json.Number:
		if parsed, err := typed.Int64(); err == nil {
			number = int(parsed)
		}
	}
	return minInt(maxInt(number, minValue), maxValue)
}

func webFirstString(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if values == nil {
			return ""
		}
		if text := strings.TrimSpace(contentString(values[key])); text != "" {
			return text
		}
	}
	return ""
}

func firstContent(values map[string]any, keys ...string) string {
	for _, key := range keys {
		if text := strings.TrimSpace(contentString(values[key])); text != "" {
			return text
		}
	}
	return ""
}

func contentString(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case []any:
		parts := make([]string, 0, len(typed))
		for _, entry := range typed {
			if text := strings.TrimSpace(contentString(entry)); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "\n\n")
	default:
		encoded, err := json.MarshalIndent(typed, "", "  ")
		if err != nil {
			return fmt.Sprint(typed)
		}
		return string(encoded)
	}
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}
