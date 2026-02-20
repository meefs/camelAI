package app

import (
	"fmt"
	"testing"
	"time"
)

func TestParseClaudeJSONLMessagesBasicFlow(t *testing.T) {
	userTS := "2026-01-02T03:04:05.000Z"
	assistantTS := "2026-01-02T03:04:06.000Z"
	resultTS := "2026-01-02T03:04:07.000Z"

	jsonl := fmt.Sprintf(`{"type":"user","uuid":"u1","timestamp":"%s","message":{"content":[{"type":"text","text":"hello"}]}}
{"type":"assistant","timestamp":"%s","message":{"id":"a1","content":[{"type":"text","text":"hi"}]}}
{"type":"result","timestamp":"%s"}`, userTS, assistantTS, resultTS)

	messages := parseClaudeJSONLMessages(jsonl, "thread-1")
	if len(messages) != 2 {
		t.Fatalf("expected 2 messages, got %d", len(messages))
	}

	if messages[0].Role != "user" || messages[0].ID != "u1" {
		t.Fatalf("unexpected first message: %+v", messages[0])
	}

	expectedUserTS := mustParseRFC3339Millis(t, userTS)
	if messages[0].CreatedAt != expectedUserTS {
		t.Fatalf("unexpected user timestamp: got %d want %d", messages[0].CreatedAt, expectedUserTS)
	}

	if messages[1].Role != "assistant" || messages[1].ID != "a1" {
		t.Fatalf("unexpected second message: %+v", messages[1])
	}

	expectedAssistantTS := mustParseRFC3339Millis(t, resultTS)
	if messages[1].CreatedAt != expectedAssistantTS {
		t.Fatalf("unexpected assistant timestamp: got %d want %d", messages[1].CreatedAt, expectedAssistantTS)
	}
}

func TestParseClaudeJSONLMessagesMetaAndCompactSummary(t *testing.T) {
	jsonl := `{"type":"assistant","timestamp":"2026-01-02T03:04:06.000Z","message":{"id":"a1","content":[{"type":"text","text":"first"}]}}
{"type":"user","uuid":"compact-1","timestamp":"2026-01-02T03:04:07.000Z","isCompactSummary":true,"message":{"content":[{"type":"text","text":"summary"}]}}
{"type":"user","uuid":"meta-1","timestamp":"2026-01-02T03:04:08.000Z","message":{"is_meta":true,"source_tool_use_id":"tool-123","content":[{"type":"text","text":"meta"}]}}`

	messages := parseClaudeJSONLMessages(jsonl, "thread-2")
	if len(messages) != 3 {
		t.Fatalf("expected 3 messages, got %d", len(messages))
	}

	if messages[0].Role != "assistant" {
		t.Fatalf("expected first message assistant, got %+v", messages[0])
	}
	if !messages[1].IsCompactSummary || messages[1].ID != "compact-1" {
		t.Fatalf("expected compact summary message, got %+v", messages[1])
	}
	if !messages[2].IsMeta || messages[2].SourceToolUseID != "tool-123" {
		t.Fatalf("expected meta message with sourceToolUseID, got %+v", messages[2])
	}
}

func mustParseRFC3339Millis(t *testing.T, value string) int64 {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339Nano, value)
	if err != nil {
		t.Fatalf("parse time %q: %v", value, err)
	}
	return parsed.UnixMilli()
}
