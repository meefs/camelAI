package app

import (
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCopySSEStreamWithUsage(t *testing.T) {
	sseStream := strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"id":"msg_01","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1500,"cache_creation_input_tokens":200,"cache_read_input_tokens":300,"output_tokens":0}}}`,
		"",
		"event: content_block_start",
		`data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`,
		"",
		"event: content_block_delta",
		`data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}`,
		"",
		"event: message_stop",
		`data: {"type":"message_stop"}`,
		"",
	}, "\n")

	w := httptest.NewRecorder()
	usage, err := copySSEStreamWithUsage(w, strings.NewReader(sseStream))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if usage.Model != "claude-sonnet-4-5-20250929" {
		t.Errorf("expected model claude-sonnet-4-5-20250929, got %s", usage.Model)
	}
	if usage.InputTokens != 1500 {
		t.Errorf("expected 1500 input tokens, got %d", usage.InputTokens)
	}
	if usage.OutputTokens != 42 {
		t.Errorf("expected 42 output tokens, got %d", usage.OutputTokens)
	}
	if usage.CacheCreationInputTokens != 200 {
		t.Errorf("expected 200 cache creation tokens, got %d", usage.CacheCreationInputTokens)
	}
	if usage.CacheReadInputTokens != 300 {
		t.Errorf("expected 300 cache read tokens, got %d", usage.CacheReadInputTokens)
	}

	// Verify the full stream was forwarded to the client.
	body := w.Body.String()
	if !strings.Contains(body, "event: message_start") {
		t.Error("response should contain message_start event")
	}
	if !strings.Contains(body, "Hello") {
		t.Error("response should contain streamed text")
	}
	if !strings.Contains(body, "message_stop") {
		t.Error("response should contain message_stop event")
	}
}

func TestCopyNonStreamingWithUsage(t *testing.T) {
	jsonBody := `{"id":"msg_01","type":"message","model":"claude-opus-4-6","usage":{"input_tokens":500,"output_tokens":150,"cache_creation_input_tokens":0,"cache_read_input_tokens":50}}`

	w := httptest.NewRecorder()
	usage, err := copyNonStreamingWithUsage(w, strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if usage.Model != "claude-opus-4-6" {
		t.Errorf("expected model claude-opus-4-6, got %s", usage.Model)
	}
	if usage.InputTokens != 500 {
		t.Errorf("expected 500 input tokens, got %d", usage.InputTokens)
	}
	if usage.OutputTokens != 150 {
		t.Errorf("expected 150 output tokens, got %d", usage.OutputTokens)
	}
	if usage.CacheReadInputTokens != 50 {
		t.Errorf("expected 50 cache read tokens, got %d", usage.CacheReadInputTokens)
	}

	// Body should be forwarded unchanged.
	if w.Body.String() != jsonBody {
		t.Error("response body should match input")
	}
}

func TestCopyResponsesSSEStreamWithUsage(t *testing.T) {
	sseStream := strings.Join([]string{
		"event: response.created",
		`data: {"type":"response.created","response":{"id":"resp_01","model":"gpt-5.4-mini"}}`,
		"",
		"event: response.completed",
		`data: {"type":"response.completed","response":{"id":"resp_01","model":"gpt-5.4-mini","usage":{"input_tokens":140,"input_tokens_details":{"cached_tokens":40},"output_tokens":25,"output_tokens_details":{"reasoning_tokens":5},"total_tokens":165}}}`,
		"",
	}, "\n")

	w := httptest.NewRecorder()
	usage, err := copySSEStreamWithUsage(w, strings.NewReader(sseStream))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if usage.Model != "gpt-5.4-mini" {
		t.Errorf("expected model gpt-5.4-mini, got %s", usage.Model)
	}
	if usage.InputTokens != 100 {
		t.Errorf("expected 100 uncached input tokens, got %d", usage.InputTokens)
	}
	if usage.CacheReadInputTokens != 40 {
		t.Errorf("expected 40 cached input tokens, got %d", usage.CacheReadInputTokens)
	}
	if usage.OutputTokens != 25 {
		t.Errorf("expected 25 output tokens, got %d", usage.OutputTokens)
	}
}

func TestCopyNonStreamingWithUsage_OpenAIResponses(t *testing.T) {
	jsonBody := `{"id":"resp_01","object":"response","model":"gpt-5.4","usage":{"input_tokens":1200,"input_tokens_details":{"cached_tokens":200},"output_tokens":300,"output_tokens_details":{"reasoning_tokens":120},"total_tokens":1500}}`

	w := httptest.NewRecorder()
	usage, err := copyNonStreamingWithUsage(w, strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if usage.Model != "gpt-5.4" {
		t.Errorf("expected model gpt-5.4, got %s", usage.Model)
	}
	if usage.InputTokens != 1000 {
		t.Errorf("expected 1000 uncached input tokens, got %d", usage.InputTokens)
	}
	if usage.CacheReadInputTokens != 200 {
		t.Errorf("expected 200 cached input tokens, got %d", usage.CacheReadInputTokens)
	}
	if usage.OutputTokens != 300 {
		t.Errorf("expected 300 output tokens, got %d", usage.OutputTokens)
	}
}

func TestCopyNonStreamingWithUsage_OpenAIChatCompletions(t *testing.T) {
	jsonBody := `{"id":"chatcmpl_01","object":"chat.completion","model":"gpt-5.4-mini","usage":{"prompt_tokens":220,"prompt_tokens_details":{"cached_tokens":20},"completion_tokens":55,"completion_tokens_details":{"reasoning_tokens":5},"total_tokens":275}}`

	w := httptest.NewRecorder()
	usage, err := copyNonStreamingWithUsage(w, strings.NewReader(jsonBody))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if usage.Model != "gpt-5.4-mini" {
		t.Errorf("expected model gpt-5.4-mini, got %s", usage.Model)
	}
	if usage.InputTokens != 200 {
		t.Errorf("expected 200 uncached input tokens, got %d", usage.InputTokens)
	}
	if usage.CacheReadInputTokens != 20 {
		t.Errorf("expected 20 cached input tokens, got %d", usage.CacheReadInputTokens)
	}
	if usage.OutputTokens != 55 {
		t.Errorf("expected 55 output tokens, got %d", usage.OutputTokens)
	}
}

func TestExtractModelFromRequestBody(t *testing.T) {
	body := `{"model":"claude-sonnet-4-5-20250929","messages":[{"role":"user","content":"Hi"}]}`
	model := extractModelFromRequestBody([]byte(body))
	if model != "claude-sonnet-4-5-20250929" {
		t.Errorf("expected claude-sonnet-4-5-20250929, got %s", model)
	}

	// Invalid JSON
	model = extractModelFromRequestBody([]byte("not json"))
	if model != "" {
		t.Errorf("expected empty model for invalid JSON, got %s", model)
	}
}

func TestUsageTokensCostUSD(t *testing.T) {
	usage := UsageTokens{
		Model:                    "claude-sonnet-4-5-20250929",
		InputTokens:              10000,
		OutputTokens:             5000,
		CacheCreationInputTokens: 1000,
		CacheReadInputTokens:     2000,
	}

	cost := usage.CostUSD()
	// Input:  10000 * 0.000003 = 0.03
	// Output: 5000  * 0.000015 = 0.075
	// Cache create: 1000 * 0.00000375 = 0.00375
	// Cache read: 2000 * 0.0000003 = 0.0006
	expected := 0.03 + 0.075 + 0.00375 + 0.0006
	if diff := cost - expected; diff > 0.000001 || diff < -0.000001 {
		t.Errorf("expected cost %.6f, got %.6f", expected, cost)
	}
}

func TestUsageTokensCostUSD_UnknownModel(t *testing.T) {
	usage := UsageTokens{
		Model:       "claude-unknown-model",
		InputTokens: 1000,
	}
	cost := usage.CostUSD()
	// Should fall back to Sonnet 4.5 pricing: 1000 * 0.000003 = 0.003
	if diff := cost - 0.003; diff > 0.000001 || diff < -0.000001 {
		t.Errorf("expected fallback cost 0.003, got %.6f", cost)
	}
}

func TestMultipleMessageStartEvents(t *testing.T) {
	// Claude SDK can make multiple API calls per turn (e.g. tool use).
	// Each call has its own message_start + message_delta pair.
	sseStream := strings.Join([]string{
		"event: message_start",
		`data: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":0}}}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":100}}`,
		"",
		"event: message_start",
		`data: {"type":"message_start","message":{"model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":1500,"cache_creation_input_tokens":0,"cache_read_input_tokens":500,"output_tokens":0}}}`,
		"",
		"event: message_delta",
		`data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":200}}`,
		"",
	}, "\n")

	w := httptest.NewRecorder()
	usage, err := copySSEStreamWithUsage(w, strings.NewReader(sseStream))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	if usage.InputTokens != 2500 {
		t.Errorf("expected accumulated input 2500, got %d", usage.InputTokens)
	}
	if usage.OutputTokens != 300 {
		t.Errorf("expected accumulated output 300, got %d", usage.OutputTokens)
	}
	if usage.CacheReadInputTokens != 500 {
		t.Errorf("expected cache read 500, got %d", usage.CacheReadInputTokens)
	}
}
