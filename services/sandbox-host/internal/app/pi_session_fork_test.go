package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestForkHostPiSessionCreatesReadableBranch(t *testing.T) {
	root := t.TempDir()
	sourceThreadID := "source-thread"
	targetThreadID := "target-thread"
	sourceDir := filepath.Join(root, sourceThreadID)
	if err := os.MkdirAll(sourceDir, 0o755); err != nil {
		t.Fatal(err)
	}

	source := `{"type":"session","version":3,"id":"source-session","timestamp":"2026-01-02T03:04:04.000Z","cwd":"/tmp/work"}
{"type":"model_change","id":"model-1","parentId":null,"timestamp":"2026-01-02T03:04:04.500Z","provider":"anthropic","modelId":"claude-sonnet-4-6"}
{"type":"message","id":"u1","parentId":"model-1","timestamp":"2026-01-02T03:04:05.000Z","message":{"role":"user","content":[{"type":"text","text":"hello"}],"timestamp":1770000000000}}
{"type":"message","id":"a1","parentId":"u1","timestamp":"2026-01-02T03:04:06.000Z","message":{"role":"assistant","content":[{"type":"text","text":"checking"},{"type":"toolCall","id":"tool-1","name":"read","arguments":{"path":"README.md"}}],"timestamp":1770000000001}}
{"type":"message","id":"tr1","parentId":"a1","timestamp":"2026-01-02T03:04:06.500Z","message":{"role":"toolResult","toolCallId":"tool-1","toolName":"read","content":[{"type":"text","text":"file contents"}],"timestamp":1770000000002}}
{"type":"message","id":"a2","parentId":"tr1","timestamp":"2026-01-02T03:04:06.750Z","message":{"role":"assistant","content":[{"type":"text","text":"done"}],"timestamp":1770000000003}}
{"type":"message","id":"u2","parentId":"a2","timestamp":"2026-01-02T03:04:07.000Z","message":{"role":"user","content":[{"type":"text","text":"later"}],"timestamp":1770000000004}}`
	if err := os.WriteFile(filepath.Join(sourceDir, "2026-01-02T03-04-04-000Z_source.jsonl"), []byte(source), 0o644); err != nil {
		t.Fatal(err)
	}

	result, err := forkHostPiSession(root, piForkSessionRequest{
		SourceThreadID: sourceThreadID,
		TargetThreadID: targetThreadID,
		EntryID:        "a1",
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.EntryID != "a2" {
		t.Fatalf("expected displayed assistant group to fork through a2, got %q", result.EntryID)
	}
	if result.EntryCount != 5 {
		t.Fatalf("expected 5 fork entries, got %d", result.EntryCount)
	}

	raw, err := os.ReadFile(result.Path)
	if err != nil {
		t.Fatal(err)
	}
	content := string(raw)
	if !strings.Contains(content, `"parentSession"`) {
		t.Fatalf("expected parent session metadata in forked file:\n%s", content)
	}
	if strings.Contains(content, `"id":"u2"`) {
		t.Fatalf("fork included entries after selected assistant message:\n%s", content)
	}
	if !strings.Contains(content, `"id":"tr1"`) || !strings.Contains(content, `"id":"a2"`) {
		t.Fatalf("fork did not include the full displayed assistant group:\n%s", content)
	}

	messages, err := readHostPiSessionMessages(root, targetThreadID)
	if err != nil {
		t.Fatal(err)
	}
	if len(messages) != 2 {
		t.Fatalf("expected forked user and assistant messages, got %d: %#v", len(messages), messages)
	}
	if messages[0].ID != "u1" || messages[1].ID != "a1" {
		t.Fatalf("unexpected forked message ids: %#v", messages)
	}
}
