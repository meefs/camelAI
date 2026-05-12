package app

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strings"
)

// usageTrackingWriter wraps an http.ResponseWriter, tees the SSE stream,
// and extracts Anthropic usage data from message_start and message_delta events.
type usageTrackingWriter struct {
	writer  io.Writer
	flusher http.Flusher // nil if underlying writer doesn't support flushing

	usage UsageTokens
}

// copyResponseBodyWithUsage copies the response body to w while extracting
// token usage from the SSE event stream. Returns the accumulated usage.
// For non-streaming responses, it parses the JSON body directly.
func copyResponseBodyWithUsage(w http.ResponseWriter, body io.Reader, streaming bool) (UsageTokens, error) {
	if w == nil || body == nil {
		return UsageTokens{}, nil
	}

	if !streaming {
		return copyNonStreamingWithUsage(w, body)
	}

	return copySSEStreamWithUsage(w, body)
}

// copyNonStreamingWithUsage handles non-streaming JSON responses.
// Reads the full body, extracts usage, then writes to the client.
func copyNonStreamingWithUsage(w http.ResponseWriter, body io.Reader) (UsageTokens, error) {
	data, err := io.ReadAll(body)
	if err != nil {
		return UsageTokens{}, err
	}

	usage := extractUsageFromJSON(data)

	_, writeErr := w.Write(data)
	if flusher, ok := w.(http.Flusher); ok {
		flusher.Flush()
	}
	return usage, writeErr
}

// copySSEStreamWithUsage tees an SSE stream to the client while parsing
// message_start and message_delta events for token usage.
func copySSEStreamWithUsage(w http.ResponseWriter, body io.Reader) (UsageTokens, error) {
	flusher, _ := w.(http.Flusher)
	scanner := bufio.NewScanner(body)
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024) // up to 1MB lines

	var usage UsageTokens
	var currentEventType string

	for scanner.Scan() {
		line := scanner.Bytes()

		// Parse SSE event type
		if bytes.HasPrefix(line, []byte("event: ")) {
			currentEventType = string(bytes.TrimPrefix(line, []byte("event: ")))
		}

		// Parse SSE data lines for usage. Some OpenAI streams do not send
		// named SSE events, so usage can arrive on a plain data chunk.
		if bytes.HasPrefix(line, []byte("data: ")) {
			data := bytes.TrimPrefix(line, []byte("data: "))
			if !bytes.Equal(bytes.TrimSpace(data), []byte("[DONE]")) {
				if isUsageEvent(currentEventType) {
					extractUsageFromSSEData(data, currentEventType, &usage)
				} else {
					applyUsageTokens(&usage, extractUsageFromJSON(data))
				}
			}
		}

		// Forward the line to the client (with newline)
		if _, err := w.Write(line); err != nil {
			return usage, err
		}
		if _, err := w.Write([]byte("\n")); err != nil {
			return usage, err
		}

		// Flush after blank lines (SSE event boundary)
		if len(line) == 0 && flusher != nil {
			flusher.Flush()
		}
	}

	return usage, scanner.Err()
}

func isUsageEvent(eventType string) bool {
	return eventType == "message_start" || eventType == "message_delta" || eventType == "response.completed" || eventType == "response.done"
}

func applyUsageTokens(target *UsageTokens, next UsageTokens) {
	if target == nil {
		return
	}
	if next.Model != "" {
		target.Model = next.Model
	}
	target.InputTokens += next.InputTokens
	target.OutputTokens += next.OutputTokens
	target.CacheCreationInputTokens += next.CacheCreationInputTokens
	target.CacheReadInputTokens += next.CacheReadInputTokens
	if next.ReportedCostUSD != nil {
		target.ReportedCostUSD = next.ReportedCostUSD
	}
	if next.UpstreamInferenceCostUSD != nil {
		target.UpstreamInferenceCostUSD = next.UpstreamInferenceCostUSD
	}
}

func applyOpenAIUsage(usage *UsageTokens, model string, inputTokens, cachedTokens, cacheWriteTokens, outputTokens int64) {
	if usage == nil {
		return
	}
	if model != "" {
		usage.Model = model
	}
	if cachedTokens < 0 {
		cachedTokens = 0
	}
	if inputTokens < cachedTokens {
		cachedTokens = inputTokens
	}
	if cacheWriteTokens < 0 {
		cacheWriteTokens = 0
	}
	if inputTokens < cachedTokens+cacheWriteTokens {
		cacheWriteTokens = inputTokens - cachedTokens
	}
	usage.InputTokens += inputTokens - cachedTokens - cacheWriteTokens
	usage.CacheCreationInputTokens += cacheWriteTokens
	usage.CacheReadInputTokens += cachedTokens
	usage.OutputTokens += outputTokens
}

func applyReportedCost(usage *UsageTokens, cost *float64) {
	if usage == nil || cost == nil {
		return
	}
	usage.ReportedCostUSD = cost
}

type usageCostDetails struct {
	UpstreamInferenceCost *float64 `json:"upstream_inference_cost"`
}

func applyUpstreamInferenceCost(usage *UsageTokens, details *usageCostDetails) {
	if usage == nil || details == nil || details.UpstreamInferenceCost == nil {
		return
	}
	usage.UpstreamInferenceCostUSD = details.UpstreamInferenceCost
}

// extractUsageFromSSEData parses a single SSE data payload and accumulates
// token usage into the provided UsageTokens.
func extractUsageFromSSEData(data []byte, eventType string, usage *UsageTokens) {
	switch eventType {
	case "message_start":
		// {"type":"message_start","message":{"model":"...","usage":{"input_tokens":N,...}}}
		var ev struct {
			Message struct {
				Model string `json:"model"`
				Usage struct {
					InputTokens              int64             `json:"input_tokens"`
					CacheCreationInputTokens int64             `json:"cache_creation_input_tokens"`
					CacheReadInputTokens     int64             `json:"cache_read_input_tokens"`
					Cost                     *float64          `json:"cost"`
					CostDetails              *usageCostDetails `json:"cost_details"`
				} `json:"usage"`
			} `json:"message"`
		}
		if json.Unmarshal(data, &ev) == nil {
			if ev.Message.Model != "" {
				usage.Model = ev.Message.Model
			}
			usage.InputTokens += ev.Message.Usage.InputTokens
			usage.CacheCreationInputTokens += ev.Message.Usage.CacheCreationInputTokens
			usage.CacheReadInputTokens += ev.Message.Usage.CacheReadInputTokens
			applyReportedCost(usage, ev.Message.Usage.Cost)
			applyUpstreamInferenceCost(usage, ev.Message.Usage.CostDetails)
		}

	case "message_delta":
		// {"type":"message_delta","usage":{"output_tokens":N}}
		var ev struct {
			Usage struct {
				OutputTokens int64             `json:"output_tokens"`
				Cost         *float64          `json:"cost"`
				CostDetails  *usageCostDetails `json:"cost_details"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &ev) == nil {
			usage.OutputTokens += ev.Usage.OutputTokens
			applyReportedCost(usage, ev.Usage.Cost)
			applyUpstreamInferenceCost(usage, ev.Usage.CostDetails)
		}

	case "response.completed", "response.done":
		// {"type":"response.completed","response":{"model":"...","usage":{"input_tokens":N,"input_tokens_details":{"cached_tokens":M},"output_tokens":K}}}
		var ev struct {
			Response struct {
				Model string `json:"model"`
				Usage struct {
					InputTokens        int64             `json:"input_tokens"`
					OutputTokens       int64             `json:"output_tokens"`
					Cost               *float64          `json:"cost"`
					CostDetails        *usageCostDetails `json:"cost_details"`
					InputTokensDetails *struct {
						CachedTokens     int64 `json:"cached_tokens"`
						CacheWriteTokens int64 `json:"cache_write_tokens"`
					} `json:"input_tokens_details"`
				} `json:"usage"`
			} `json:"response"`
		}
		if json.Unmarshal(data, &ev) == nil {
			var cachedTokens int64
			var cacheWriteTokens int64
			if ev.Response.Usage.InputTokensDetails != nil {
				cachedTokens = ev.Response.Usage.InputTokensDetails.CachedTokens
				cacheWriteTokens = ev.Response.Usage.InputTokensDetails.CacheWriteTokens
			}
			applyOpenAIUsage(
				usage,
				ev.Response.Model,
				ev.Response.Usage.InputTokens,
				cachedTokens,
				cacheWriteTokens,
				ev.Response.Usage.OutputTokens,
			)
			applyReportedCost(usage, ev.Response.Usage.Cost)
			applyUpstreamInferenceCost(usage, ev.Response.Usage.CostDetails)
		}
	}
}

// extractUsageFromJSON parses a non-streaming Anthropic, Responses API, or
// OpenAI chat completions response body.
func extractUsageFromJSON(data []byte) UsageTokens {
	var responsesResp struct {
		Object string `json:"object"`
		Type   string `json:"type"`
		Model  string `json:"model"`
		Usage  struct {
			InputTokens        int64             `json:"input_tokens"`
			OutputTokens       int64             `json:"output_tokens"`
			Cost               *float64          `json:"cost"`
			CostDetails        *usageCostDetails `json:"cost_details"`
			InputTokensDetails *struct {
				CachedTokens     int64 `json:"cached_tokens"`
				CacheWriteTokens int64 `json:"cache_write_tokens"`
			} `json:"input_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &responsesResp) == nil {
		if responsesResp.Object == "response" || responsesResp.Type == "response" || responsesResp.Usage.InputTokensDetails != nil {
			var usage UsageTokens
			var cachedTokens int64
			var cacheWriteTokens int64
			if responsesResp.Usage.InputTokensDetails != nil {
				cachedTokens = responsesResp.Usage.InputTokensDetails.CachedTokens
				cacheWriteTokens = responsesResp.Usage.InputTokensDetails.CacheWriteTokens
			}
			applyOpenAIUsage(
				&usage,
				responsesResp.Model,
				responsesResp.Usage.InputTokens,
				cachedTokens,
				cacheWriteTokens,
				responsesResp.Usage.OutputTokens,
			)
			applyReportedCost(&usage, responsesResp.Usage.Cost)
			applyUpstreamInferenceCost(&usage, responsesResp.Usage.CostDetails)
			return usage
		}
	}

	var resp struct {
		Model string `json:"model"`
		Usage struct {
			InputTokens              int64             `json:"input_tokens"`
			OutputTokens             int64             `json:"output_tokens"`
			CacheCreationInputTokens int64             `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64             `json:"cache_read_input_tokens"`
			Cost                     *float64          `json:"cost"`
			CostDetails              *usageCostDetails `json:"cost_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &resp) != nil {
		resp = struct {
			Model string `json:"model"`
			Usage struct {
				InputTokens              int64             `json:"input_tokens"`
				OutputTokens             int64             `json:"output_tokens"`
				CacheCreationInputTokens int64             `json:"cache_creation_input_tokens"`
				CacheReadInputTokens     int64             `json:"cache_read_input_tokens"`
				Cost                     *float64          `json:"cost"`
				CostDetails              *usageCostDetails `json:"cost_details"`
			} `json:"usage"`
		}{}
	} else if resp.Usage.InputTokens > 0 || resp.Usage.OutputTokens > 0 ||
		resp.Usage.CacheCreationInputTokens > 0 || resp.Usage.CacheReadInputTokens > 0 {
		usage := UsageTokens{
			Model:                    resp.Model,
			InputTokens:              resp.Usage.InputTokens,
			OutputTokens:             resp.Usage.OutputTokens,
			CacheCreationInputTokens: resp.Usage.CacheCreationInputTokens,
			CacheReadInputTokens:     resp.Usage.CacheReadInputTokens,
			ReportedCostUSD:          resp.Usage.Cost,
		}
		applyUpstreamInferenceCost(&usage, resp.Usage.CostDetails)
		return usage
	}

	var chatResp struct {
		Model string `json:"model"`
		Usage struct {
			PromptTokens        int64             `json:"prompt_tokens"`
			CompletionTokens    int64             `json:"completion_tokens"`
			Cost                *float64          `json:"cost"`
			CostDetails         *usageCostDetails `json:"cost_details"`
			PromptTokensDetails *struct {
				CachedTokens     int64 `json:"cached_tokens"`
				CacheWriteTokens int64 `json:"cache_write_tokens"`
			} `json:"prompt_tokens_details"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &chatResp) != nil {
		if resp.Usage.Cost != nil {
			return UsageTokens{ReportedCostUSD: resp.Usage.Cost}
		}
		return UsageTokens{}
	}
	var usage UsageTokens
	var cachedTokens int64
	var cacheWriteTokens int64
	if chatResp.Usage.PromptTokensDetails != nil {
		cachedTokens = chatResp.Usage.PromptTokensDetails.CachedTokens
		cacheWriteTokens = chatResp.Usage.PromptTokensDetails.CacheWriteTokens
	}
	applyOpenAIUsage(&usage, chatResp.Model, chatResp.Usage.PromptTokens, cachedTokens, cacheWriteTokens, chatResp.Usage.CompletionTokens)
	applyReportedCost(&usage, chatResp.Usage.Cost)
	applyUpstreamInferenceCost(&usage, chatResp.Usage.CostDetails)
	if !usage.HasBillableTokens() && resp.Usage.Cost != nil {
		return UsageTokens{ReportedCostUSD: resp.Usage.Cost}
	}
	return usage
}

// extractModelFromRequestBody reads the "model" field from the request JSON.
// Used as a fallback when the response stream doesn't include a model.
func extractModelFromRequestBody(rawBody []byte) string {
	var req struct {
		Model string `json:"model"`
	}
	if json.Unmarshal(rawBody, &req) == nil {
		return strings.TrimSpace(req.Model)
	}
	return ""
}
