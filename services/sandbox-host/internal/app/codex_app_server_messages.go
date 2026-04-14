package app

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

type codexRPCError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type codexRPCEnvelope struct {
	ID     *int            `json:"id"`
	Result json.RawMessage `json:"result"`
	Error  *codexRPCError  `json:"error"`
}

type codexThreadListResponse struct {
	Data []codexThreadSummary `json:"data"`
}

type codexThreadSummary struct {
	ID string `json:"id"`
}

type codexThreadReadResponse struct {
	Thread codexThread `json:"thread"`
}

type codexThread struct {
	Turns []codexTurn `json:"turns"`
}

type codexTurn struct {
	ID          string            `json:"id"`
	Items       []json.RawMessage `json:"items"`
	StartedAt   *int64            `json:"startedAt"`
	CompletedAt *int64            `json:"completedAt"`
}

func readCodexAppServerMessages(ctx context.Context, codexExecutablePath, codexHome, camelThreadID, codexSessionID string) ([]parsedChatMessage, error) {
	camelThreadID = strings.TrimSpace(camelThreadID)
	if camelThreadID == "" {
		return nil, errors.New("thread id is required")
	}

	codexExecutablePath = strings.TrimSpace(codexExecutablePath)
	if codexExecutablePath == "" {
		return nil, errors.New("codex executable path is required")
	}
	if _, err := os.Stat(codexExecutablePath); err != nil {
		return nil, fmt.Errorf("host codex executable unavailable at %s: %w", codexExecutablePath, err)
	}

	codexHome = strings.TrimSpace(codexHome)
	if codexHome == "" {
		return nil, errors.New("codex home path is required")
	}

	codexThreadID := strings.TrimSpace(codexSessionID)
	if codexThreadID == "" {
		var err error
		codexThreadID, err = listLatestCodexThreadID(ctx, codexExecutablePath, codexHome)
		if err != nil {
			return nil, err
		}
	}

	messages, err := readCodexThreadMessages(ctx, codexExecutablePath, codexHome, camelThreadID, codexThreadID)
	if err == nil || codexSessionID == "" {
		return messages, err
	}

	fallbackThreadID, fallbackErr := listLatestCodexThreadID(ctx, codexExecutablePath, codexHome)
	if fallbackErr != nil {
		return nil, err
	}
	if fallbackThreadID == codexThreadID {
		return nil, err
	}
	return readCodexThreadMessages(ctx, codexExecutablePath, codexHome, camelThreadID, fallbackThreadID)
}

func listLatestCodexThreadID(ctx context.Context, codexExecutablePath, codexHome string) (string, error) {
	raw, err := runCodexAppServerRequest(ctx, codexExecutablePath, codexHome, "thread/list", map[string]any{
		"limit": 1,
	})
	if err != nil {
		return "", err
	}

	var response codexThreadListResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return "", fmt.Errorf("parse codex thread/list response: %w", err)
	}
	if len(response.Data) == 0 || strings.TrimSpace(response.Data[0].ID) == "" {
		return "", errors.New("codex thread/list returned no threads")
	}
	return strings.TrimSpace(response.Data[0].ID), nil
}

func readCodexThreadMessages(ctx context.Context, codexExecutablePath, codexHome, camelThreadID, codexThreadID string) ([]parsedChatMessage, error) {
	raw, err := runCodexAppServerRequest(ctx, codexExecutablePath, codexHome, "thread/read", map[string]any{
		"threadId":     codexThreadID,
		"includeTurns": true,
	})
	if err != nil {
		return nil, err
	}

	var response codexThreadReadResponse
	if err := json.Unmarshal(raw, &response); err != nil {
		return nil, fmt.Errorf("parse codex thread/read response: %w", err)
	}
	return parseCodexThreadReadMessages(response, camelThreadID), nil
}

func runCodexAppServerRequest(ctx context.Context, codexExecutablePath, codexHome, method string, params any) (json.RawMessage, error) {
	const initializeRequestID = 1
	requestID := 2

	writeLine := func(stdin io.Writer, line map[string]any) error {
		encoded, err := json.Marshal(line)
		if err != nil {
			return err
		}
		if _, err := stdin.Write(append(encoded, '\n')); err != nil {
			return err
		}
		return nil
	}

	timeoutCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()

	cmd := exec.CommandContext(
		timeoutCtx,
		codexExecutablePath,
		"app-server",
	)
	cmd.Dir = codexHome
	cmd.Env = append(os.Environ(), "CODEX_HOME="+codexHome)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Start(); err != nil {
		return nil, err
	}

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)

	if err := writeLine(stdin, map[string]any{
		"method": "initialize",
		"id":     initializeRequestID,
		"params": map[string]any{
			"clientInfo": map[string]any{
				"name":    "camelai_history_loader",
				"title":   "camelAI History Loader",
				"version": "0.1.0",
			},
		},
	}); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return nil, err
	}
	if _, err := readCodexRPCResult(scanner, initializeRequestID); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		if timeoutCtx.Err() != nil {
			return nil, fmt.Errorf("codex app-server initialize timed out: %w", timeoutCtx.Err())
		}
		return nil, codexAppServerError(err, stderr.String())
	}

	if err := writeLine(stdin, map[string]any{
		"method": "initialized",
		"params": map[string]any{},
	}); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return nil, err
	}
	if err := writeLine(stdin, map[string]any{
		"method": method,
		"id":     requestID,
		"params": params,
	}); err != nil {
		_ = stdin.Close()
		_ = cmd.Wait()
		return nil, err
	}

	result, err := readCodexRPCResult(scanner, requestID)
	_ = stdin.Close()
	waitErr := cmd.Wait()
	if err != nil {
		if timeoutCtx.Err() != nil {
			return nil, fmt.Errorf("codex app-server %s timed out: %w", method, timeoutCtx.Err())
		}
		return nil, codexAppServerError(err, stderr.String())
	}
	if waitErr != nil {
		if timeoutCtx.Err() != nil {
			return nil, fmt.Errorf("codex app-server %s timed out: %w", method, timeoutCtx.Err())
		}
		return nil, fmt.Errorf("codex app-server %s failed: %w: %s", method, waitErr, strings.TrimSpace(stderr.String()))
	}
	return result, nil
}

func readCodexRPCResult(scanner *bufio.Scanner, requestID int) (json.RawMessage, error) {
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}

		var message codexRPCEnvelope
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			continue
		}
		if message.ID == nil || *message.ID != requestID {
			continue
		}
		if message.Error != nil {
			return nil, fmt.Errorf("codex app-server returned %s", message.Error.Message)
		}
		if len(message.Result) == 0 {
			return nil, errors.New("codex app-server response missing result")
		}
		return append(json.RawMessage(nil), message.Result...), nil
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read codex app-server output: %w", err)
	}
	return nil, errors.New("codex app-server response not found")
}

func codexAppServerError(err error, stderr string) error {
	stderrText := strings.TrimSpace(stderr)
	if stderrText != "" {
		return fmt.Errorf("%w: %s", err, stderrText)
	}
	return err
}

func parseCodexThreadReadMessages(response codexThreadReadResponse, camelThreadID string) []parsedChatMessage {
	messages := make([]parsedChatMessage, 0)
	for _, turn := range response.Thread.Turns {
		assistantBlocks := make([]any, 0)
		assistantCreatedAt := codexTurnCreatedAt(turn)

		for _, rawItem := range turn.Items {
			item := codexItemMap(rawItem)
			itemType := codexString(item["type"])
			itemID := codexString(item["id"])
			if itemID == "" {
				itemID = fmt.Sprintf("codex_item_%d", len(messages)+len(assistantBlocks))
			}

			switch itemType {
			case "userMessage":
				text := extractCodexItemText(item)
				if strings.TrimSpace(text) == "" {
					continue
				}
				if len(assistantBlocks) > 0 {
					messages = append(messages, codexAssistantMessage(turn, camelThreadID, assistantBlocks, assistantCreatedAt))
					assistantBlocks = make([]any, 0)
				}
				messages = append(messages, parsedChatMessage{
					ID:        itemID,
					ThreadID:  camelThreadID,
					Role:      "user",
					Content:   text,
					CreatedAt: codexTurnStartedAt(turn),
				})
			case "hookPrompt":
				continue
			case "agentMessage":
				text := codexString(item["text"])
				if text == "" {
					text = extractCodexItemText(item)
				}
				if strings.TrimSpace(text) == "" {
					continue
				}
				assistantBlocks = append(assistantBlocks, map[string]any{
					"type":     "text",
					"text":     text,
					"itemId":   itemID,
					"itemKind": itemType,
				})
			case "plan":
				text := codexString(item["text"])
				if strings.TrimSpace(text) == "" {
					continue
				}
				assistantBlocks = append(assistantBlocks, map[string]any{
					"type":      "thinking",
					"thinking":  text,
					"itemId":    itemID,
					"itemKind":  itemType,
					"label":     "Plan",
					"summaries": []string{},
				})
			case "reasoning":
				text := extractCodexReasoningContent(item)
				summaries := extractCodexStringSlice(item["summary"])
				if strings.TrimSpace(text) == "" && len(summaries) == 0 {
					continue
				}
				assistantBlocks = append(assistantBlocks, map[string]any{
					"type":      "thinking",
					"thinking":  text,
					"itemId":    itemID,
					"itemKind":  itemType,
					"label":     "Reasoning",
					"summaries": summaries,
				})
			default:
				if itemType == "" {
					continue
				}
				assistantBlocks = append(assistantBlocks, codexGenericToolBlocks(itemID, itemType, item)...)
			}
		}

		if len(assistantBlocks) > 0 {
			messages = append(messages, codexAssistantMessage(turn, camelThreadID, assistantBlocks, assistantCreatedAt))
		}
	}
	return messages
}

func codexAssistantMessage(turn codexTurn, camelThreadID string, blocks []any, createdAt int64) parsedChatMessage {
	id := turn.ID
	if id == "" {
		id = fmt.Sprintf("codex_assistant_%d", createdAt)
	}
	return parsedChatMessage{
		ID:        "assistant_" + id,
		ThreadID:  camelThreadID,
		Role:      "assistant",
		Content:   blocks,
		CreatedAt: createdAt,
	}
}

func codexGenericToolBlocks(itemID, itemType string, item map[string]any) []any {
	input := make(map[string]any, len(item))
	for key, value := range item {
		if key == "id" || key == "type" {
			continue
		}
		input[key] = value
	}

	result := ""
	if len(input) > 0 {
		if encoded, err := json.Marshal(input); err == nil {
			result = string(encoded)
		}
	}
	if result == "" {
		result = itemType
	}

	return []any{
		map[string]any{
			"type":     "tool_use",
			"id":       itemID,
			"name":     "Codex:" + itemType,
			"input":    input,
			"itemKind": itemType,
		},
		map[string]any{
			"type":        "tool_result",
			"tool_use_id": itemID,
			"content":     result,
			"itemId":      itemID,
			"itemKind":    itemType,
		},
	}
}

func codexItemMap(raw json.RawMessage) map[string]any {
	var item map[string]any
	if err := json.Unmarshal(raw, &item); err != nil || item == nil {
		return map[string]any{}
	}
	return item
}

func codexString(value any) string {
	if text, ok := value.(string); ok {
		return text
	}
	return ""
}

func extractCodexStringSlice(value any) []string {
	values, ok := value.([]any)
	if !ok {
		return []string{}
	}
	out := make([]string, 0, len(values))
	for _, value := range values {
		if text := codexString(value); text != "" {
			out = append(out, text)
		}
	}
	return out
}

func extractCodexItemText(item map[string]any) string {
	if text := codexString(item["text"]); text != "" {
		return text
	}

	parts, ok := item["content"].([]any)
	if !ok {
		return ""
	}

	var text strings.Builder
	for _, part := range parts {
		partMap, ok := part.(map[string]any)
		if !ok {
			continue
		}
		partType := codexString(partMap["type"])
		if partType == "text" || partType == "input_text" || partType == "output_text" {
			text.WriteString(codexString(partMap["text"]))
		}
	}
	return text.String()
}

func extractCodexReasoningContent(item map[string]any) string {
	parts, ok := item["content"].([]any)
	if !ok {
		return ""
	}

	var text strings.Builder
	for _, part := range parts {
		partMap, ok := part.(map[string]any)
		if !ok {
			continue
		}
		text.WriteString(codexString(partMap["text"]))
	}
	return text.String()
}

func codexTurnStartedAt(turn codexTurn) int64 {
	if turn.StartedAt != nil && *turn.StartedAt > 0 {
		return *turn.StartedAt * 1000
	}
	return nowMillis()
}

func codexTurnCreatedAt(turn codexTurn) int64 {
	if turn.CompletedAt != nil && *turn.CompletedAt > 0 {
		return *turn.CompletedAt * 1000
	}
	return codexTurnStartedAt(turn)
}
