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

		// Parse SSE data lines for usage-bearing events
		if bytes.HasPrefix(line, []byte("data: ")) && isUsageEvent(currentEventType) {
			data := bytes.TrimPrefix(line, []byte("data: "))
			extractUsageFromSSEData(data, currentEventType, &usage)
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
	return eventType == "message_start" || eventType == "message_delta"
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
					InputTokens              int64 `json:"input_tokens"`
					CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
					CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
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
		}

	case "message_delta":
		// {"type":"message_delta","usage":{"output_tokens":N}}
		var ev struct {
			Usage struct {
				OutputTokens int64 `json:"output_tokens"`
			} `json:"usage"`
		}
		if json.Unmarshal(data, &ev) == nil {
			usage.OutputTokens += ev.Usage.OutputTokens
		}
	}
}

// extractUsageFromJSON parses a non-streaming Anthropic response body.
func extractUsageFromJSON(data []byte) UsageTokens {
	var resp struct {
		Model string `json:"model"`
		Usage struct {
			InputTokens              int64 `json:"input_tokens"`
			OutputTokens             int64 `json:"output_tokens"`
			CacheCreationInputTokens int64 `json:"cache_creation_input_tokens"`
			CacheReadInputTokens     int64 `json:"cache_read_input_tokens"`
		} `json:"usage"`
	}
	if json.Unmarshal(data, &resp) != nil {
		return UsageTokens{}
	}
	return UsageTokens{
		Model:                    resp.Model,
		InputTokens:              resp.Usage.InputTokens,
		OutputTokens:             resp.Usage.OutputTokens,
		CacheCreationInputTokens: resp.Usage.CacheCreationInputTokens,
		CacheReadInputTokens:     resp.Usage.CacheReadInputTokens,
	}
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
