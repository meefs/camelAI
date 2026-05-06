package app

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

func readHostPiSessionMessages(sessionRoot, threadID string) ([]parsedChatMessage, error) {
	sessionRoot = strings.TrimSpace(sessionRoot)
	threadID = strings.TrimSpace(threadID)
	if sessionRoot == "" || threadID == "" {
		return nil, nil
	}
	if strings.ContainsAny(threadID, `/\`) {
		return nil, fmt.Errorf("invalid thread id")
	}

	sessionDir := filepath.Join(sessionRoot, threadID)
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	files := make([]fs.DirEntry, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		files = append(files, entry)
	}
	sort.Slice(files, func(i, j int) bool {
		return files[i].Name() < files[j].Name()
	})

	messages := make([]parsedChatMessage, 0)
	seen := make(map[string]bool)
	for _, entry := range files {
		content, err := os.ReadFile(filepath.Join(sessionDir, entry.Name()))
		if err != nil {
			return nil, err
		}
		for _, message := range parsePiJSONLMessages(string(content), threadID) {
			if message.ID != "" {
				if seen[message.ID] {
					continue
				}
				seen[message.ID] = true
			}
			messages = append(messages, message)
		}
	}
	return messages, nil
}

func parsePiJSONLMessages(fileContent string, threadID string) []parsedChatMessage {
	lines := strings.Split(fileContent, "\n")
	messages := make([]parsedChatMessage, 0, len(lines))

	assistantSegments := make([]assistantSegment, 0)
	assistantGroupID := ""
	var assistantGroupCreatedAt *int64

	flushAssistantGroup := func() {
		if len(assistantSegments) == 0 {
			return
		}

		content := make([]any, 0)
		for _, segment := range assistantSegments {
			if blocks, ok := asSlice(segment.Content); ok {
				content = append(content, blocks...)
			}
		}
		content = normalizePiAssistantContentOrder(content)

		id := assistantGroupID
		if id == "" {
			id = assistantSegments[0].ID
		}
		if id == "" {
			id = fmt.Sprintf("pi_assistant_%d", len(messages))
		}

		createdAt := assistantSegments[0].CreatedAt
		if assistantGroupCreatedAt != nil {
			createdAt = *assistantGroupCreatedAt
		}
		if createdAt <= 0 {
			createdAt = nowMillis()
		}

		messages = append(messages, parsedChatMessage{
			ID:        id,
			ThreadID:  threadID,
			Role:      "assistant",
			Content:   content,
			CreatedAt: createdAt,
		})

		assistantSegments = assistantSegments[:0]
		assistantGroupID = ""
		assistantGroupCreatedAt = nil
	}

	upsertAssistantSegment := func(id string, content any, createdAt int64) {
		if assistantGroupID == "" {
			assistantGroupID = id
		}
		if assistantGroupCreatedAt == nil || createdAt > *assistantGroupCreatedAt {
			ts := createdAt
			assistantGroupCreatedAt = &ts
		}
		if len(assistantSegments) > 0 {
			last := &assistantSegments[len(assistantSegments)-1]
			if last.ID == id {
				last.Content = mergeContentBlocks(last.Content, content)
				return
			}
		}
		assistantSegments = append(assistantSegments, assistantSegment{
			ID:        id,
			Content:   content,
			CreatedAt: createdAt,
		})
	}

	appendToolResult := func(toolUseID string, content any, createdAt int64) {
		block := map[string]any{
			"type":        "tool_result",
			"tool_use_id": toolUseID,
			"content":     content,
		}
		if strings.TrimSpace(toolUseID) == "" {
			block["tool_use_id"] = fmt.Sprintf("pi_tool_result_%d", len(messages)+len(assistantSegments))
		}

		if len(assistantSegments) == 0 {
			upsertAssistantSegment(fmt.Sprintf("pi_tool_result_%d", len(messages)), []any{block}, createdAt)
			return
		}

		last := &assistantSegments[len(assistantSegments)-1]
		existingBlocks, _ := asSlice(last.Content)
		merged := make([]any, 0, len(existingBlocks)+1)
		merged = append(merged, existingBlocks...)
		merged = append(merged, block)
		last.Content = merged
		if assistantGroupCreatedAt == nil || createdAt > *assistantGroupCreatedAt {
			ts := createdAt
			assistantGroupCreatedAt = &ts
		}
	}

	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}

		var event any
		if err := json.Unmarshal([]byte(line), &event); err != nil {
			continue
		}
		eventMap, ok := asMap(event)
		if !ok {
			continue
		}
		if eventType, _ := asString(eventMap["type"]); eventType != "message" {
			continue
		}

		messageMap, ok := asMap(eventMap["message"])
		if !ok {
			continue
		}
		role, _ := asString(messageMap["role"])
		createdAt := piCreatedAt(eventMap, messageMap)

		switch role {
		case "user":
			flushAssistantGroup()
			content := piContentBlocks(messageMap["content"])
			if len(content) == 0 {
				continue
			}
			id := firstString(eventMap, "id")
			if id == "" {
				id = fmt.Sprintf("pi_user_%d", len(messages))
			}
			messages = append(messages, parsedChatMessage{
				ID:        id,
				ThreadID:  threadID,
				Role:      "user",
				Content:   content,
				CreatedAt: createdAt,
			})
		case "assistant":
			content := piContentBlocks(messageMap["content"])
			if len(content) == 0 {
				continue
			}
			id := firstString(eventMap, "id")
			if id == "" {
				id = fmt.Sprintf("pi_assistant_%d", len(messages)+len(assistantSegments))
			}
			upsertAssistantSegment(id, content, createdAt)
		case "toolResult":
			appendToolResult(
				firstString(messageMap, "toolCallId", "tool_call_id"),
				piToolResultContent(messageMap["content"]),
				createdAt,
			)
		}
	}

	flushAssistantGroup()
	return messages
}

func piCreatedAt(eventMap map[string]any, messageMap map[string]any) int64 {
	if parsed, ok := parseEventTimestamp(eventMap["timestamp"]); ok {
		return parsed
	}
	if parsed, ok := piTimestampMillis(messageMap["timestamp"]); ok {
		return parsed
	}
	return nowMillis()
}

func piTimestampMillis(value any) (int64, bool) {
	switch v := value.(type) {
	case float64:
		return int64(v), true
	case int64:
		return v, true
	case int:
		return int64(v), true
	default:
		return 0, false
	}
}

func piContentBlocks(value any) []any {
	rawBlocks, ok := asSlice(value)
	if !ok {
		if text, ok := asString(value); ok && text != "" {
			return []any{map[string]any{"type": "text", "text": text}}
		}
		return nil
	}

	blocks := make([]any, 0, len(rawBlocks))
	for _, rawBlock := range rawBlocks {
		block, ok := asMap(rawBlock)
		if !ok {
			continue
		}
		blockType, _ := asString(block["type"])
		switch blockType {
		case "text":
			text, _ := asString(block["text"])
			if text != "" {
				blocks = append(blocks, map[string]any{"type": "text", "text": text})
			}
		case "thinking":
			thinking, _ := asString(block["thinking"])
			if thinking == "" {
				continue
			}
			out := map[string]any{"type": "thinking", "thinking": thinking}
			if signature := firstString(block, "signature", "thinkingSignature", "thinking_signature"); signature != "" {
				out["signature"] = signature
			}
			blocks = append(blocks, out)
		case "toolCall":
			id := firstString(block, "id")
			name := firstString(block, "name")
			if id == "" || name == "" {
				continue
			}
			input, _ := asMap(block["arguments"])
			if input == nil {
				input = map[string]any{}
			}
			blocks = append(blocks, map[string]any{
				"type":  "tool_use",
				"id":    id,
				"name":  piUIToolName(name),
				"input": input,
			})
		}
	}
	return blocks
}

func normalizePiAssistantContentOrder(blocks []any) []any {
	firstTextIndex := -1
	lateThinking := make([]any, 0)
	kept := make([]any, 0, len(blocks))

	for _, rawBlock := range blocks {
		block, _ := asMap(rawBlock)
		blockType := firstString(block, "type")
		if firstTextIndex >= 0 && (blockType == "thinking" || blockType == "redacted_thinking") {
			lateThinking = append(lateThinking, rawBlock)
			continue
		}
		if firstTextIndex < 0 && blockType == "text" {
			firstTextIndex = len(kept)
		}
		kept = append(kept, rawBlock)
	}

	if len(lateThinking) == 0 || firstTextIndex < 0 {
		return blocks
	}

	out := make([]any, 0, len(blocks))
	out = append(out, kept[:firstTextIndex]...)
	out = append(out, lateThinking...)
	out = append(out, kept[firstTextIndex:]...)
	return out
}

func piToolResultContent(value any) any {
	blocks := piContentBlocks(value)
	if len(blocks) == 0 {
		if text, ok := asString(value); ok {
			return text
		}
		if value == nil {
			return ""
		}
		encoded, err := json.Marshal(value)
		if err != nil {
			return fmt.Sprint(value)
		}
		return string(encoded)
	}

	parts := make([]string, 0, len(blocks))
	for _, block := range blocks {
		blockMap, ok := asMap(block)
		if !ok {
			continue
		}
		if firstString(blockMap, "type") == "text" {
			if text := firstString(blockMap, "text"); text != "" {
				parts = append(parts, text)
			}
		}
	}
	if len(parts) == 0 {
		return blocks
	}
	return strings.Join(parts, "\n")
}

func piUIToolName(name string) string {
	switch strings.TrimSpace(name) {
	case "bash":
		return "Bash"
	case "read":
		return "Read"
	case "write":
		return "Write"
	case "edit":
		return "Edit"
	case "ls", "find":
		return "Glob"
	case "grep":
		return "Grep"
	case "agent", "explore":
		return "Agent"
	case "ask_user_question", "AskUserQuestion":
		return "AskUserQuestion"
	case "todo_write", "TodoWrite":
		return "TodoWrite"
	case "web_search", "WebSearch":
		return "WebSearch"
	case "web_fetch", "WebFetch":
		return "WebFetch"
	default:
		return name
	}
}
