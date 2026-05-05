package app

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

type piForkSessionRequest struct {
	SourceThreadID string `json:"sourceThreadId"`
	TargetThreadID string `json:"targetThreadId"`
	EntryID        string `json:"entryId"`
}

type piSessionForkResult struct {
	Path       string `json:"path"`
	EntryID    string `json:"entryId"`
	EntryCount int    `json:"entryCount"`
}

type piForkEntry struct {
	value map[string]any
	file  string
}

func forkHostPiSession(sessionRoot string, req piForkSessionRequest) (*piSessionForkResult, error) {
	sessionRoot = strings.TrimSpace(sessionRoot)
	sourceThreadID := strings.TrimSpace(req.SourceThreadID)
	targetThreadID := strings.TrimSpace(req.TargetThreadID)
	entryID := strings.TrimSpace(req.EntryID)
	if sessionRoot == "" {
		return nil, fmt.Errorf("Pi session root is not configured")
	}
	if sourceThreadID == "" || targetThreadID == "" || entryID == "" {
		return nil, fmt.Errorf("sourceThreadId, targetThreadId, and entryId are required")
	}
	if strings.ContainsAny(sourceThreadID, `/\`) || strings.ContainsAny(targetThreadID, `/\`) {
		return nil, fmt.Errorf("invalid thread id")
	}

	sourceDir := filepath.Join(sessionRoot, sourceThreadID)
	targetDir := filepath.Join(sessionRoot, targetThreadID)
	if entries, err := os.ReadDir(targetDir); err == nil {
		for _, entry := range entries {
			if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".jsonl") {
				return nil, fmt.Errorf("target Pi session already exists")
			}
		}
	} else if !os.IsNotExist(err) {
		return nil, err
	}

	files, err := piSessionJSONLFiles(sourceDir)
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("source Pi session not found")
	}

	entriesByID := make(map[string]piForkEntry)
	orderedEntries := make([]piForkEntry, 0)
	var targetEntry *piForkEntry
	var sourceSession map[string]any
	for _, file := range files {
		header, entries, err := readPiSessionForkFile(file)
		if err != nil {
			return nil, err
		}
		if sourceSession == nil && header != nil {
			sourceSession = header
		}
		for _, entry := range entries {
			id := firstString(entry, "id")
			if id == "" {
				continue
			}
			record := piForkEntry{value: entry, file: file}
			orderedEntries = append(orderedEntries, record)
			if _, exists := entriesByID[id]; !exists {
				entriesByID[id] = record
			}
			if id == entryID && targetEntry == nil {
				copyRecord := record
				targetEntry = &copyRecord
			}
		}
	}
	if targetEntry == nil {
		return nil, fmt.Errorf("entry %q not found in source Pi session", entryID)
	}

	leafID := piForkDisplayLeafID(orderedEntries, entryID)
	if leafID == "" {
		leafID = entryID
	}
	leafEntry := *targetEntry
	if entry, ok := entriesByID[leafID]; ok {
		leafEntry = entry
	}

	branch, err := piForkBranchEntries(entriesByID, leafID)
	if err != nil {
		return nil, err
	}
	if len(branch) == 0 {
		return nil, fmt.Errorf("no forkable entries found for %q", entryID)
	}

	if err := os.MkdirAll(targetDir, 0o755); err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	sessionID := "forked-" + targetThreadID + "-" + randomID()
	filename := fmt.Sprintf("%s_%s.jsonl", formatPiSessionFilenameTimestamp(now), sessionID)
	path := filepath.Join(targetDir, filename)

	cwd := firstString(sourceSession, "cwd")
	header := map[string]any{
		"type":      "session",
		"version":   3,
		"id":        sessionID,
		"timestamp": now.Format("2006-01-02T15:04:05.000Z"),
		"cwd":       cwd,
		"parentSession": map[string]any{
			"threadId":         sourceThreadID,
			"path":             leafEntry.file,
			"entryId":          leafID,
			"requestedEntryId": entryID,
		},
	}
	if cwd == "" {
		delete(header, "cwd")
	}

	out, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
	if err != nil {
		return nil, err
	}
	defer out.Close()

	writer := bufio.NewWriter(out)
	if err := writePiForkJSONLine(writer, header); err != nil {
		return nil, err
	}
	for _, entry := range branch {
		if err := writePiForkJSONLine(writer, entry); err != nil {
			return nil, err
		}
	}
	if err := writer.Flush(); err != nil {
		return nil, err
	}

	return &piSessionForkResult{Path: path, EntryID: leafID, EntryCount: len(branch)}, nil
}

func piSessionJSONLFiles(sessionDir string) ([]string, error) {
	entries, err := os.ReadDir(sessionDir)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".jsonl") {
			continue
		}
		files = append(files, filepath.Join(sessionDir, entry.Name()))
	}
	sort.Strings(files)
	return files, nil
}

func readPiSessionForkFile(path string) (map[string]any, []map[string]any, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()

	var session map[string]any
	entries := make([]map[string]any, 0)
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 64*1024), 16*1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var entry map[string]any
		if err := json.Unmarshal([]byte(line), &entry); err != nil {
			return nil, nil, err
		}
		switch firstString(entry, "type") {
		case "session":
			if session == nil {
				session = entry
			}
		case "label":
			continue
		default:
			entries = append(entries, entry)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, nil, err
	}
	return session, entries, nil
}

func piForkBranchEntries(entriesByID map[string]piForkEntry, leafID string) ([]map[string]any, error) {
	reversed := make([]map[string]any, 0)
	seen := make(map[string]bool)
	for id := leafID; id != ""; {
		if seen[id] {
			return nil, fmt.Errorf("cycle detected in Pi session ancestry at %q", id)
		}
		seen[id] = true
		entry, ok := entriesByID[id]
		if !ok {
			return nil, fmt.Errorf("missing parent entry %q", id)
		}
		reversed = append(reversed, entry.value)
		parentID := firstString(entry.value, "parentId")
		id = parentID
	}

	branch := make([]map[string]any, 0, len(reversed))
	for i := len(reversed) - 1; i >= 0; i-- {
		branch = append(branch, reversed[i])
	}
	return branch, nil
}

func piForkDisplayLeafID(entries []piForkEntry, displayEntryID string) string {
	inAssistantGroup := false
	leafID := ""
	for _, entry := range entries {
		id := firstString(entry.value, "id")
		entryType := firstString(entry.value, "type")
		if entryType != "message" {
			continue
		}
		messageMap, ok := asMap(entry.value["message"])
		if !ok {
			continue
		}
		role := firstString(messageMap, "role")
		if !inAssistantGroup {
			if id == displayEntryID && role == "assistant" {
				inAssistantGroup = true
				leafID = id
			}
			continue
		}
		if role == "user" {
			break
		}
		if role == "assistant" || role == "toolResult" {
			if id != "" {
				leafID = id
			}
		}
	}
	return leafID
}

func writePiForkJSONLine(writer *bufio.Writer, value map[string]any) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return err
	}
	if _, err := writer.Write(encoded); err != nil {
		return err
	}
	return writer.WriteByte('\n')
}

func formatPiSessionFilenameTimestamp(timestamp time.Time) string {
	return fmt.Sprintf("%s-%03dZ", timestamp.UTC().Format("2006-01-02T15-04-05"), timestamp.Nanosecond()/int(time.Millisecond))
}

func latestHostPiAssistantEntryID(sessionRoot, threadID string) (string, error) {
	sessionRoot = strings.TrimSpace(sessionRoot)
	threadID = strings.TrimSpace(threadID)
	if sessionRoot == "" || threadID == "" {
		return "", nil
	}
	if strings.ContainsAny(threadID, `/\`) {
		return "", fmt.Errorf("invalid thread id")
	}

	files, err := piSessionJSONLFiles(filepath.Join(sessionRoot, threadID))
	if err != nil {
		return "", err
	}

	latestID := ""
	for _, file := range files {
		_, entries, err := readPiSessionForkFile(file)
		if err != nil {
			return "", err
		}
		for _, entry := range entries {
			if firstString(entry, "type") != "message" {
				continue
			}
			messageMap, ok := asMap(entry["message"])
			if !ok || firstString(messageMap, "role") != "assistant" {
				continue
			}
			if id := firstString(entry, "id"); id != "" {
				latestID = id
			}
		}
	}
	return latestID, nil
}
