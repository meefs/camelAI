package app

import (
	"encoding/json"
	"fmt"
	"strings"
)

func parseCodexRolloutMessages(fileContent string, camelThreadID string) []parsedChatMessage {
	lines := strings.Split(fileContent, "\n")
	messages := make([]parsedChatMessage, 0)
	assistantBlocks := make([]any, 0)
	assistantCreatedAt := int64(0)
	assistantID := ""

	flushAssistant := func() {
		if len(assistantBlocks) == 0 {
			return
		}
		id := assistantID
		if id == "" {
			id = fmt.Sprintf("codex_rollout_assistant_%d", len(messages))
		}
		if assistantCreatedAt <= 0 {
			assistantCreatedAt = nowMillis()
		}
		messages = append(messages, parsedChatMessage{
			ID:        id,
			ThreadID:  camelThreadID,
			Role:      "assistant",
			Content:   assistantBlocks,
			CreatedAt: assistantCreatedAt,
		})
		assistantBlocks = make([]any, 0)
		assistantCreatedAt = 0
		assistantID = ""
	}

	appendAssistantBlock := func(timestamp any, block map[string]any) {
		if assistantCreatedAt <= 0 {
			assistantCreatedAt = toCreatedAt(timestamp)
		}
		assistantBlocks = append(assistantBlocks, block)
	}

	for _, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" {
			continue
		}

		var eventMap map[string]any
		if err := json.Unmarshal([]byte(line), &eventMap); err != nil {
			continue
		}
		eventType := firstString(eventMap, "type")
		payload, _ := asMap(eventMap["payload"])
		timestamp := eventMap["timestamp"]

		switch eventType {
		case "event_msg":
			switch firstString(payload, "type") {
			case "user_message":
				text := firstString(payload, "message")
				if strings.TrimSpace(text) == "" {
					continue
				}
				flushAssistant()
				messages = append(messages, parsedChatMessage{
					ID:        fmt.Sprintf("codex_rollout_user_%d", len(messages)),
					ThreadID:  camelThreadID,
					Role:      "user",
					Content:   text,
					CreatedAt: toCreatedAt(timestamp),
				})
			case "task_complete":
				flushAssistant()
			}
		case "response_item":
			itemType := firstString(payload, "type")
			itemID := firstString(payload, "id", "call_id")
			if itemID == "" {
				itemID = fmt.Sprintf("codex_rollout_item_%d", len(messages)+len(assistantBlocks))
			}
			switch itemType {
			case "message":
				if firstString(payload, "role") != "assistant" {
					continue
				}
				text := codexRolloutMessageText(payload["content"])
				if strings.TrimSpace(text) == "" {
					continue
				}
				if assistantID == "" {
					assistantID = itemID
				}
				appendAssistantBlock(timestamp, map[string]any{
					"type":     "text",
					"text":     text,
					"itemId":   itemID,
					"itemKind": itemType,
				})
			case "reasoning":
				text := codexRolloutReasoningText(payload)
				summaries := extractCodexStringSlice(payload["summary"])
				if strings.TrimSpace(text) == "" && len(summaries) == 0 {
					continue
				}
				appendAssistantBlock(timestamp, map[string]any{
					"type":      "thinking",
					"thinking":  text,
					"itemId":    itemID,
					"itemKind":  itemType,
					"label":     "Reasoning",
					"summaries": summaries,
				})
			case "function_call":
				name := firstString(payload, "name")
				if name == "" {
					name = "function_call"
				}
				toolID := firstString(payload, "call_id")
				if toolID == "" {
					toolID = itemID
				}
				input := codexRolloutFunctionArguments(payload["arguments"])
				appendAssistantBlock(timestamp, map[string]any{
					"type":     "tool_use",
					"id":       toolID,
					"name":     name,
					"input":    input,
					"itemKind": itemType,
				})
			case "function_call_output":
				callID := firstString(payload, "call_id")
				content := payload["output"]
				if text, ok := asString(content); ok {
					content = text
				}
				appendAssistantBlock(timestamp, map[string]any{
					"type":        "tool_result",
					"tool_use_id": callID,
					"content":     content,
					"itemId":      itemID,
					"itemKind":    itemType,
				})
			}
		}
	}

	flushAssistant()
	return messages
}

func codexRolloutMessageText(content any) string {
	blocks, ok := asSlice(content)
	if !ok {
		text, _ := asString(content)
		return text
	}
	var out strings.Builder
	for _, rawBlock := range blocks {
		block, ok := asMap(rawBlock)
		if !ok {
			continue
		}
		switch firstString(block, "type") {
		case "output_text", "text":
			out.WriteString(firstString(block, "text"))
		}
	}
	return out.String()
}

func codexRolloutReasoningText(payload map[string]any) string {
	if text := firstString(payload, "content"); text != "" {
		return text
	}
	content, ok := asSlice(payload["content"])
	if !ok {
		return ""
	}
	var out strings.Builder
	for _, rawBlock := range content {
		block, ok := asMap(rawBlock)
		if !ok {
			continue
		}
		out.WriteString(firstString(block, "text"))
	}
	return out.String()
}

func codexRolloutFunctionArguments(value any) map[string]any {
	if arguments, ok := asMap(value); ok {
		return arguments
	}
	if text, ok := asString(value); ok && strings.TrimSpace(text) != "" {
		var arguments map[string]any
		if err := json.Unmarshal([]byte(text), &arguments); err == nil && arguments != nil {
			return arguments
		}
		return map[string]any{"arguments": text}
	}
	return map[string]any{}
}
