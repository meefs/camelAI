package app

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/chiridion/sandbox-host/internal/container"
	"github.com/gorilla/websocket"
)

//go:embed pi_system_prompt.md
var hostPiSystemPromptAppend string

func (s *Server) serveHostPiChat(
	clientConn *websocket.Conn,
	name string,
	route WorkspaceRoute,
	opts container.EnsureContainerOptions,
	threadID string,
	threadKey string,
) error {
	s.trace("host_pi_chat_ws_open", map[string]any{
		"container":   name,
		"orgId":       route.OrgID,
		"workspaceId": route.WorkspaceID,
		"threadId":    threadID,
		"threadKey":   threadKey,
	})

	ctx, cancel := context.WithCancel(context.Background())
	bridge := &hostPiBridge{
		server:     s,
		client:     clientConn,
		container:  name,
		route:      route,
		opts:       opts,
		threadID:   threadID,
		threadKey:  threadKey,
		nextSeq:    1,
		ctx:        ctx,
		cancel:     cancel,
		activeItem: fmt.Sprintf("pi_agent_%s", randomID()),
		askToken:   randomID(),
		questions:  make(map[string]chan hostPiQuestionResult),
		toolArgs:   make(map[string]map[string]any),
	}
	s.registerHostPiBridge(bridge)

	var closeOnce sync.Once
	closeAll := func(code int, reason string) {
		closeOnce.Do(func() {
			cancel()
			s.unregisterHostPiBridge(bridge)
			bridge.failPendingQuestions("host Pi chat session closed")
			bridge.stopProcess()

			now := time.Now().UTC()
			var updated *ProxyThreadContext
			s.proxyMu.Lock()
			if ctx := s.proxyThreads[threadKey]; ctx != nil {
				ctx.ClosedAt = &now
				ctx.ExpiresAt = now.Add(s.cfg.ProxyThreadCloseGrace)
				updated = copyProxyThreadContext(ctx)
			}
			s.proxyMu.Unlock()
			s.upsertProxyThreadState(updated)

			s.trace("host_pi_chat_ws_close", map[string]any{
				"container": name,
				"threadId":  threadID,
				"threadKey": threadKey,
				"code":      code,
				"reason":    reason,
			})
			_ = clientConn.Close()
		})
	}
	defer closeAll(1000, "session ended")

	for {
		_, data, err := clientConn.ReadMessage()
		if err != nil {
			closeAll(1000, "client read: "+err.Error())
			return nil
		}
		if err := bridge.handleClientMessage(data); err != nil {
			bridge.sendEvent(map[string]any{
				"type":   "error",
				"error":  err.Error(),
				"source": "host_pi",
			})
		}
	}
}

type hostPiBridge struct {
	server    *Server
	client    *websocket.Conn
	container string
	route     WorkspaceRoute
	opts      container.EnsureContainerOptions
	threadID  string
	threadKey string

	ctx    context.Context
	cancel context.CancelFunc

	mu       sync.Mutex
	stateMu  sync.Mutex
	nextSeq  int64
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	started  bool
	active   bool
	finalBuf strings.Builder

	activeItem    string
	activeItemBuf strings.Builder
	reasoningItem string

	askToken  string
	questions map[string]chan hostPiQuestionResult
	toolArgs  map[string]map[string]any
}

type hostPiQuestionResult struct {
	answers map[string]any
	err     error
}

type hostPiAskQuestionRequest struct {
	ThreadID   string `json:"threadId"`
	Token      string `json:"token"`
	ToolCallID string `json:"toolCallId"`
	Questions  []any  `json:"questions"`
}

type hostPiTodoStateRequest struct {
	ThreadID string `json:"threadId"`
	Token    string `json:"token"`
	Todos    []any  `json:"todos"`
}

type hostPiWebToolRequest struct {
	ThreadID string         `json:"threadId"`
	Token    string         `json:"token"`
	Params   map[string]any `json:"params"`
}

func (b *hostPiBridge) handleClientMessage(data []byte) error {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		return nil
	}
	messageType, _ := msg["type"].(string)

	switch messageType {
	case "init":
		if lastSeq, ok := numberAsInt64(msg["lastSeq"]); ok && lastSeq >= b.nextSeq {
			b.nextSeq = lastSeq + 1
		}
		env := mapStringValues(msg["env"])
		if err := b.start(env); err != nil {
			return err
		}
		b.sendEvent(map[string]any{"type": "session", "sessionId": b.threadID})
		b.sendEvent(map[string]any{"type": "ready"})
	case "ping":
		b.sendEvent(map[string]any{"type": "pong", "ts": msg["ts"]})
	case "message":
		if err := b.start(nil); err != nil {
			return err
		}
		content, _ := msg["content"].(string)
		content = strings.TrimSpace(content)
		if content == "" {
			return nil
		}
		if userID, _ := msg["userId"].(string); strings.TrimSpace(userID) != "" {
			b.sendEvent(map[string]any{"type": "active_turn_identity", "userId": strings.TrimSpace(userID), "source": "host_pi_message_start"})
		}
		b.warmContainerForToolCalls()
		command := map[string]any{
			"id":      fmt.Sprintf("prompt_%s", randomID()),
			"type":    "prompt",
			"message": content,
		}
		b.stateMu.Lock()
		active := b.active
		b.stateMu.Unlock()
		if active {
			command["streamingBehavior"] = "steer"
		}
		return b.writePiCommand(command)
	case "set_model":
		if err := b.start(nil); err != nil {
			return err
		}
		model, ok := b.resolvePiModelCommand(msg)
		if !ok {
			return errors.New("invalid model selection")
		}
		provider, modelID, ok := strings.Cut(model, "/")
		if !ok || strings.TrimSpace(provider) == "" || strings.TrimSpace(modelID) == "" {
			return fmt.Errorf("invalid Pi model reference %q", model)
		}
		return b.writePiCommand(map[string]any{
			"id":       fmt.Sprintf("set_model_%s", randomID()),
			"type":     "set_model",
			"provider": strings.TrimSpace(provider),
			"modelId":  strings.TrimSpace(modelID),
		})
	case "stop":
		if b.started {
			return b.writePiCommand(map[string]any{"id": fmt.Sprintf("abort_%s", randomID()), "type": "abort"})
		}
	case "question_response":
		questionID := strings.TrimSpace(stringValue(msg["questionId"], ""))
		answers, _ := msg["answers"].(map[string]any)
		if questionID != "" && answers != nil {
			b.answerQuestion(questionID, answers)
		}
		return nil
	}
	return nil
}

func (b *hostPiBridge) warmContainerForToolCalls() {
	select {
	case <-b.ctx.Done():
		return
	default:
	}

	go func() {
		if _, err := b.server.containers.EnsureContainer(b.container, b.opts); err != nil {
			log.Printf("[SandboxHost] host Pi container warmup failed container=%s thread=%s: %v", b.container, b.threadID, err)
			b.server.trace("host_pi_container_warmup_failed", map[string]any{
				"container": b.container,
				"threadId":  b.threadID,
				"error":     err.Error(),
			})
			return
		}
		b.server.trace("host_pi_container_warmed", map[string]any{
			"container": b.container,
			"threadId":  b.threadID,
		})
	}()
}

func (b *hostPiBridge) start(sessionEnv map[string]string) error {
	b.mu.Lock()
	if b.started {
		b.mu.Unlock()
		return nil
	}
	b.mu.Unlock()

	if strings.TrimSpace(b.server.cfg.HostPiPath) == "" {
		return errors.New("HOST_PI_PATH is not configured")
	}
	if _, err := os.Stat(b.server.cfg.HostPiPath); err != nil {
		return fmt.Errorf("host Pi executable unavailable at %s: %w", b.server.cfg.HostPiPath, err)
	}
	if strings.TrimSpace(b.server.cfg.HostPiExtensionPath) == "" {
		return errors.New("HOST_PI_EXTENSION_PATH is not configured")
	}
	if _, err := os.Stat(b.server.cfg.HostPiExtensionPath); err != nil {
		return fmt.Errorf("host Pi extension unavailable at %s: %w", b.server.cfg.HostPiExtensionPath, err)
	}
	skillsPath := strings.TrimSpace(b.server.cfg.HostPiSkillsPath)
	if skillsPath != "" {
		if _, err := os.Stat(skillsPath); err != nil {
			return fmt.Errorf("host Pi skills unavailable at %s: %w", skillsPath, err)
		}
	}

	workspacePath, err := b.server.workspaces.Ensure(b.container)
	if err != nil {
		return err
	}

	sessionDir := filepath.Join(b.server.cfg.HostPiSessionRoot, b.threadID)
	if err := os.MkdirAll(sessionDir, 0o700); err != nil {
		return err
	}
	if migratedCount, err := b.server.migrateLegacyThreadToHostPiSession(b.container, b.threadID, sessionDir, workspacePath, sessionEnv); err != nil {
		log.Printf("[SandboxHost] host Pi legacy migration failed thread=%s: %v", b.threadID, err)
	} else if migratedCount > 0 {
		b.server.trace("host_pi_legacy_session_migrated", map[string]any{"threadId": b.threadID, "messages": migratedCount})
	}
	if repairedCount, err := repairHostPiSessionDir(sessionDir); err != nil {
		log.Printf("[SandboxHost] host Pi session repair failed thread=%s: %v", b.threadID, err)
	} else if repairedCount > 0 {
		b.server.trace("host_pi_session_repaired", map[string]any{"threadId": b.threadID, "messages": repairedCount})
	}

	args := []string{
		"--mode", "rpc",
		"--no-builtin-tools",
		"--no-context-files",
		"--continue",
		"-e", b.server.cfg.HostPiExtensionPath,
	}
	args = append(args, hostPiSkillArgs(skillsPath)...)
	args = append(args, hostPiToolArgs()...)
	args = append(args, hostPiSystemPromptArgs(workspacePath)...)
	args = append(args, "--session-dir", sessionDir)
	piModel := b.resolvePiModel(sessionEnv)
	if piModel == "" {
		return errors.New("unable to resolve Pi model from thread configuration")
	}
	args = append(args, "--model", piModel)

	cmd := exec.CommandContext(b.ctx, b.server.cfg.HostPiPath, args...)
	cmd.Dir = workspacePath
	cmd.Env = b.piEnv(workspacePath, sessionEnv)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		_ = stdin.Close()
		return err
	}

	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		return err
	}

	b.mu.Lock()
	b.cmd = cmd
	b.stdin = stdin
	b.started = true
	b.mu.Unlock()

	go b.readPiStdout(stdout)
	go b.readPiStderr(stderr)
	go func() {
		err := cmd.Wait()
		if b.ctx.Err() == nil && err != nil {
			b.sendEvent(map[string]any{
				"type":   "error",
				"error":  err.Error(),
				"source": "host_pi_process",
			})
		}
	}()

	b.server.trace("host_pi_started", map[string]any{
		"container":  b.container,
		"threadId":   b.threadID,
		"model":      piModel,
		"sessionDir": sessionDir,
		"skillsPath": skillsPath,
		"workspace":  workspacePath,
	})
	return nil
}

func hostPiSkillArgs(skillsPath string) []string {
	skillsPath = strings.TrimSpace(skillsPath)
	if skillsPath == "" {
		return nil
	}
	return []string{"--skill", skillsPath}
}

func hostPiToolArgs() []string {
	tools := []string{
		"read",
		"write",
		"edit",
		"ls",
		"grep",
		"find",
		"bash",
		"AskUserQuestion",
		"ask_user_question",
		"TodoWrite",
		"Explore",
		"explore",
		"Agent",
		"agent",
		"WebSearch",
		"web_search",
		"WebFetch",
		"web_fetch",
	}
	return []string{"--tools", strings.Join(tools, ",")}
}

func hostPiSystemPromptArgs(workspacePath string) []string {
	parts := []string{strings.TrimSpace(hostPiSystemPromptAppend)}
	if contextPrompt := hostPiWorkspaceContextPrompt(workspacePath); contextPrompt != "" {
		parts = append(parts, contextPrompt)
	}
	prompt := strings.TrimSpace(strings.Join(parts, "\n\n"))
	if prompt == "" {
		return nil
	}
	return []string{"--append-system-prompt", prompt}
}

const hostPiContextMaxBytes = 512 * 1024

func hostPiWorkspaceContextPrompt(workspacePath string) string {
	contextPath, content, ok := hostPiReadWorkspaceContextFile(workspacePath)
	if !ok {
		return ""
	}

	displayPath := "/home/claude"
	if rel, err := filepath.Rel(workspacePath, contextPath); err == nil && rel != "." {
		displayPath = filepath.ToSlash(filepath.Join(displayPath, rel))
	}

	return strings.TrimSpace(fmt.Sprintf(`# Project Context

Project-specific instructions and guidelines loaded from the sandbox workspace:

## %s

%s`, displayPath, content))
}

func hostPiReadWorkspaceContextFile(workspacePath string) (string, string, bool) {
	workspacePath = strings.TrimSpace(workspacePath)
	if workspacePath == "" {
		return "", "", false
	}

	for _, filename := range []string{"AGENTS.md", "CLAUDE.md"} {
		candidate := filepath.Join(workspacePath, filename)
		info, err := os.Stat(candidate)
		if err != nil || info.IsDir() {
			continue
		}

		content, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}

		truncated := false
		if len(content) > hostPiContextMaxBytes {
			content = content[:hostPiContextMaxBytes]
			truncated = true
		}

		text := string(content)
		if truncated {
			text += fmt.Sprintf("\n\n[Truncated: loaded first %d bytes of %s]", hostPiContextMaxBytes, filename)
		}
		return candidate, strings.TrimSpace(text), true
	}

	return "", "", false
}

func (b *hostPiBridge) resolvePiModel(sessionEnv map[string]string) string {
	if configured := strings.TrimSpace(b.server.cfg.HostPiModel); configured != "" {
		return configured
	}

	provider := strings.ToLower(strings.TrimSpace(sessionEnv["CHIRIDION_CHAT_PROVIDER"]))
	switch provider {
	case "codex":
		switch strings.TrimSpace(sessionEnv["CHIRIDION_CODEX_MODEL"]) {
		case "gpt-5.4-mini":
			if b.openRouterUpstreamEnabled() {
				return "camel/openai/gpt-5.4-mini"
			}
			return "openai/gpt-5.4-mini"
		case "gpt-5.4":
			if b.openRouterUpstreamEnabled() {
				return "camel/openai/gpt-5.4"
			}
			return "openai/gpt-5.4"
		case "kimi-k2.6":
			return "camel/~moonshotai/kimi-latest"
		case "grok-4.3":
			return "camel/x-ai/grok-4.3"
		}
	case "claude":
		switch strings.TrimSpace(sessionEnv["CHIRIDION_CLAUDE_MODEL"]) {
		case "haiku":
			if b.openRouterUpstreamEnabled() {
				return "camel/" + openRouterClaudeModel("haiku")
			}
			return "anthropic/claude-haiku-4-5-20251001"
		case "opus":
			if b.openRouterUpstreamEnabled() {
				return "camel/" + openRouterClaudeModel("opus")
			}
			return "anthropic/claude-opus-4-6"
		case "sonnet":
			if b.openRouterUpstreamEnabled() {
				return "camel/" + openRouterClaudeModel("sonnet")
			}
			return "anthropic/claude-sonnet-4-6"
		}
	}

	return ""
}

func (b *hostPiBridge) resolvePiModelCommand(msg map[string]any) (string, bool) {
	if configured := strings.TrimSpace(b.server.cfg.HostPiModel); configured != "" {
		return configured, true
	}

	model := strings.TrimSpace(stringValue(msg["model"], ""))
	if model == "" {
		return "", false
	}
	switch model {
	case "gpt-5.4-mini":
		if b.openRouterUpstreamEnabled() {
			return "camel/openai/gpt-5.4-mini", true
		}
		return "openai/gpt-5.4-mini", true
	case "gpt-5.4":
		if b.openRouterUpstreamEnabled() {
			return "camel/openai/gpt-5.4", true
		}
		return "openai/gpt-5.4", true
	case "kimi-k2.6":
		return "camel/~moonshotai/kimi-latest", true
	case "grok-4.3":
		return "camel/x-ai/grok-4.3", true
	case "haiku":
		if b.openRouterUpstreamEnabled() {
			return "camel/" + openRouterClaudeModel("haiku"), true
		}
		return "anthropic/claude-haiku-4-5-20251001", true
	case "opus":
		if b.openRouterUpstreamEnabled() {
			return "camel/" + openRouterClaudeModel("opus"), true
		}
		return "anthropic/claude-opus-4-6", true
	case "sonnet":
		if b.openRouterUpstreamEnabled() {
			return "camel/" + openRouterClaudeModel("sonnet"), true
		}
		return "anthropic/claude-sonnet-4-6", true
	default:
		if strings.Contains(model, "/") {
			return model, true
		}
		return "", false
	}
}

func (b *hostPiBridge) piEnv(workspacePath string, sessionEnv map[string]string) []string {
	env := map[string]string{}
	for _, entry := range os.Environ() {
		key, value, ok := strings.Cut(entry, "=")
		if ok {
			env[key] = value
		}
	}
	for key, value := range sessionEnv {
		env[key] = value
	}

	threadEscaped := url.PathEscape(b.threadID)
	controlBase := fmt.Sprintf("http://127.0.0.1:%d", b.server.cfg.Port)
	proxyBase := fmt.Sprintf("http://127.0.0.1:%d/proxy/%s", b.server.cfg.ProxyPort, threadEscaped)
	containerProxyBase := strings.TrimRight(b.server.containers.ContainerProxyBaseURL(), "/")
	if containerProxyBase != "" {
		containerProxyBase += "/" + threadEscaped
	}

	env["OPENAI_BASE_URL"] = proxyBase + "/api/openai/v1"
	env["OPENAI_API_KEY"] = "proxy"
	env["OPENAI_PROXY_URL"] = proxyBase + "/api/openai"
	env["OPENROUTER_BASE_URL"] = proxyBase + "/api/openrouter/v1"
	env["OPENROUTER_ANTHROPIC_BASE_URL"] = proxyBase + "/api/claude"
	env["CAMEL_API_KEY"] = "proxy"
	env["ANTHROPIC_BASE_URL"] = proxyBase + "/api/claude"
	env["ANTHROPIC_API_KEY"] = "proxy"
	if b.openRouterUpstreamEnabled() {
		env["CHIRIDION_OPENROUTER_UPSTREAM"] = "1"
	} else {
		env["CHIRIDION_OPENROUTER_UPSTREAM"] = ""
	}
	env["MCP_SERVER_URL"] = proxyBase + "/mcp"
	env["DATA_PROXY_URL"] = proxyBase + "/api"
	env["RESEND_PROXY_URL"] = proxyBase + "/api/resend"
	env["CLOUDFLARE_API_BASE_URL"] = proxyBase + "/client/v4"
	env["CLOUDFLARE_API_TOKEN"] = "proxy"
	env["THREAD_ID"] = b.threadID
	env["WORKSPACE_ID"] = b.route.WorkspaceID
	env["ORG_ID"] = b.route.OrgID
	env["CHIRIDION_PI_WORKSPACE_CWD"] = workspacePath
	env["CHIRIDION_PI_CONTAINER_CWD"] = "/home/claude"
	env["CHIRIDION_CONTAINER_PROXY_BASE_URL"] = containerProxyBase
	env["CHIRIDION_HOST_PI_PATH"] = b.server.cfg.HostPiPath
	env["CHIRIDION_HOST_PI_EXTENSION_PATH"] = b.server.cfg.HostPiExtensionPath
	env["CHIRIDION_HOST_PI_SKILLS_PATH"] = b.server.cfg.HostPiSkillsPath
	env["CHIRIDION_CONTAINER_PI_SKILLS_PATH"] = b.server.cfg.HostPiContainerSkillsPath
	env["CHIRIDION_HOST_PI_SESSION_ROOT"] = b.server.cfg.HostPiSessionRoot
	env["CHIRIDION_ASK_USER_QUESTION_URL"] = controlBase + "/internal/host-pi/ask-user-question"
	env["CHIRIDION_ASK_USER_QUESTION_TOKEN"] = b.askToken
	env["CHIRIDION_TODO_STATE_URL"] = controlBase + "/internal/host-pi/todo-state"
	env["CHIRIDION_WEB_SEARCH_URL"] = controlBase + "/internal/host-pi/web-search"
	env["CHIRIDION_WEB_FETCH_URL"] = controlBase + "/internal/host-pi/web-fetch"
	env["CHIRIDION_HOST_PI_TOKEN"] = b.askToken
	env["CHIRIDION_CONTAINER_EXEC_URL"] = fmt.Sprintf(
		"%s/v1/workspaces/%s/%s/exec",
		controlBase,
		url.PathEscape(b.route.OrgID),
		url.PathEscape(b.route.WorkspaceID),
	)

	out := make([]string, 0, len(env))
	for key, value := range env {
		out = append(out, key+"="+value)
	}
	return out
}

func (b *hostPiBridge) openRouterUpstreamEnabled() bool {
	if b == nil || b.server == nil {
		return false
	}

	b.server.proxyMu.Lock()
	threadContext := b.server.proxyThreads[b.threadKey]
	b.server.proxyMu.Unlock()
	if threadContext == nil {
		return false
	}

	if threadContext.ByokOpenRouterKey != "" {
		return true
	}
	if threadContext.ByokAnthropicKey != "" || threadContext.ByokBedrockToken != "" || threadContext.ByokOpenAIKey != "" {
		return false
	}
	return b.server.cfg.AIGatewayBaseURL != ""
}

func (b *hostPiBridge) readPiStdout(stdout io.Reader) {
	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 0, 64*1024), 64*1024*1024)
	for scanner.Scan() {
		line := bytes.TrimSpace(scanner.Bytes())
		if len(line) == 0 {
			continue
		}
		var event map[string]any
		if err := json.Unmarshal(line, &event); err != nil {
			b.server.trace("host_pi_stdout_invalid_json", map[string]any{
				"threadId": b.threadID,
				"bytes":    len(line),
			})
			continue
		}
		b.handlePiEvent(event)
	}
	if err := scanner.Err(); err != nil && b.ctx.Err() == nil {
		b.sendEvent(map[string]any{"type": "error", "error": err.Error(), "source": "host_pi_stdout"})
	}
}

func (b *hostPiBridge) readPiStderr(stderr io.Reader) {
	scanner := bufio.NewScanner(stderr)
	scanner.Buffer(make([]byte, 0, 16*1024), 1024*1024)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		log.Printf("[SandboxHost] host pi stderr thread=%s: %s", b.threadID, line)
	}
}

func (b *hostPiBridge) handlePiEvent(event map[string]any) {
	eventType, _ := event["type"].(string)
	switch eventType {
	case "response":
		if success, _ := event["success"].(bool); !success {
			b.sendEvent(map[string]any{
				"type":   "error",
				"error":  stringifyJSON(event["error"]),
				"source": "host_pi_response",
			})
		}
	case "agent_start":
		b.stateMu.Lock()
		b.active = true
		b.finalBuf.Reset()
		b.activeItemBuf.Reset()
		b.activeItem = fmt.Sprintf("pi_agent_%s", randomID())
		b.reasoningItem = ""
		b.stateMu.Unlock()
	case "message_update":
		assistantEvent, _ := event["assistantMessageEvent"].(map[string]any)
		deltaType, _ := assistantEvent["type"].(string)
		switch deltaType {
		case "start":
			b.stateMu.Lock()
			b.reasoningItem = ""
			b.stateMu.Unlock()
		case "thinking_start":
			contentIndex := piContentIndex(assistantEvent)
			b.stateMu.Lock()
			if contentIndex == 0 || b.reasoningItem == "" {
				b.reasoningItem = fmt.Sprintf("pi_reasoning_%s", randomID())
			}
			b.stateMu.Unlock()
		case "thinking_delta":
			delta, _ := assistantEvent["delta"].(string)
			if delta != "" {
				contentIndex := piContentIndex(assistantEvent)
				b.stateMu.Lock()
				if b.reasoningItem == "" {
					b.reasoningItem = fmt.Sprintf("pi_reasoning_%s", randomID())
				}
				reasoningItem := b.reasoningItem
				b.stateMu.Unlock()
				b.sendRuntimeEvent("item/reasoning/textDelta", map[string]any{
					"threadId":     b.threadID,
					"itemId":       reasoningItem,
					"contentIndex": contentIndex,
					"delta":        delta,
				})
			}
		case "text_delta":
			delta, _ := assistantEvent["delta"].(string)
			if delta != "" {
				b.stateMu.Lock()
				if b.activeItem == "" {
					b.activeItem = fmt.Sprintf("pi_agent_%s", randomID())
				}
				b.finalBuf.WriteString(delta)
				b.activeItemBuf.WriteString(delta)
				activeItem := b.activeItem
				b.stateMu.Unlock()
				b.sendRuntimeEvent("item/agentMessage/delta", map[string]any{
					"threadId": b.threadID,
					"itemId":   activeItem,
					"delta":    delta,
				})
			}
		}
	case "message_end":
		message, _ := event["message"].(map[string]any)
		if !isPiAssistantMessage(message) {
			return
		}
		if text := extractPiText(message); text != "" {
			b.stateMu.Lock()
			if b.activeItem == "" {
				b.activeItem = fmt.Sprintf("pi_agent_%s", randomID())
			}
			shouldSendCompleted := b.activeItemBuf.Len() == 0
			if shouldSendCompleted {
				b.finalBuf.WriteString(text)
				b.activeItemBuf.WriteString(text)
			}
			activeItem := b.activeItem
			b.activeItem = fmt.Sprintf("pi_agent_%s", randomID())
			b.activeItemBuf.Reset()
			b.stateMu.Unlock()
			if shouldSendCompleted {
				b.sendRuntimeEvent("item/completed", map[string]any{
					"threadId": b.threadID,
					"item": map[string]any{
						"id":   activeItem,
						"type": "agentMessage",
						"text": text,
					},
				})
			}
		}
	case "tool_execution_start":
		b.handlePiToolStart(event)
	case "tool_execution_update":
		b.handlePiToolUpdate(event)
	case "tool_execution_end":
		b.handlePiToolEnd(event)
	case "agent_end":
		b.stateMu.Lock()
		b.active = false
		finalText := b.finalBuf.String()
		b.stateMu.Unlock()
		if finalText == "" {
			finalText = extractPiAssistantText(event["messages"])
		}
		params := map[string]any{"threadId": b.threadID}
		if entryID, err := latestHostPiAssistantEntryID(b.server.cfg.HostPiSessionRoot, b.threadID); err != nil {
			log.Printf("[SandboxHost] failed to resolve latest Pi assistant entry for fork thread=%s: %v", b.threadID, err)
		} else if entryID != "" {
			params["forkEntryId"] = entryID
		}
		b.sendRuntimeEvent("turn/completed", params)
		b.sendEvent(map[string]any{
			"type":      "result",
			"threadId":  b.threadID,
			"result":    finalText,
			"sessionId": b.threadID,
		})
	}
}

func (s *Server) registerHostPiBridge(bridge *hostPiBridge) {
	if bridge == nil || strings.TrimSpace(bridge.threadID) == "" {
		return
	}
	s.hostPiMu.Lock()
	defer s.hostPiMu.Unlock()
	if s.hostPiChats == nil {
		s.hostPiChats = make(map[string]*hostPiBridge)
	}
	s.hostPiChats[bridge.threadID] = bridge
}

func (s *Server) unregisterHostPiBridge(bridge *hostPiBridge) {
	if bridge == nil || strings.TrimSpace(bridge.threadID) == "" {
		return
	}
	s.hostPiMu.Lock()
	defer s.hostPiMu.Unlock()
	if s.hostPiChats[bridge.threadID] == bridge {
		delete(s.hostPiChats, bridge.threadID)
	}
}

func (s *Server) hostPiBridgeForThread(threadID string) *hostPiBridge {
	s.hostPiMu.Lock()
	defer s.hostPiMu.Unlock()
	return s.hostPiChats[strings.TrimSpace(threadID)]
}

func (s *Server) handleHostPiAskUserQuestionRoute(w http.ResponseWriter, req *http.Request, sourceIP string) {
	if req.Method != http.MethodPost {
		errorJSON(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !isLoopbackSourceIP(sourceIP) {
		errorJSON(w, "Host Pi question endpoint is loopback only", http.StatusForbidden)
		return
	}

	var body hostPiAskQuestionRequest
	if err := decodeJSON(req, &body); err != nil {
		errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.ThreadID) == "" {
		errorJSON(w, "threadId required", http.StatusBadRequest)
		return
	}
	if len(body.Questions) == 0 {
		errorJSON(w, "questions required", http.StatusBadRequest)
		return
	}

	bridge := s.hostPiBridgeForThread(body.ThreadID)
	if bridge == nil {
		errorJSON(w, "Host Pi chat session not found", http.StatusNotFound)
		return
	}
	if body.Token == "" || body.Token != bridge.askToken {
		errorJSON(w, "Invalid Host Pi question token", http.StatusForbidden)
		return
	}

	answers, err := bridge.askUserQuestions(req.Context(), body.Questions, body.ToolCallID)
	if err != nil {
		errorJSON(w, err.Error(), http.StatusServiceUnavailable)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"answers": answers})
}

func (s *Server) handleHostPiTodoStateRoute(w http.ResponseWriter, req *http.Request, sourceIP string) {
	if req.Method != http.MethodPost {
		errorJSON(w, "Method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !isLoopbackSourceIP(sourceIP) {
		errorJSON(w, "Host Pi todo endpoint is loopback only", http.StatusForbidden)
		return
	}

	var body hostPiTodoStateRequest
	if err := decodeJSON(req, &body); err != nil {
		errorJSON(w, "Invalid JSON body", http.StatusBadRequest)
		return
	}
	if strings.TrimSpace(body.ThreadID) == "" {
		errorJSON(w, "threadId required", http.StatusBadRequest)
		return
	}
	if body.Todos == nil {
		errorJSON(w, "todos required", http.StatusBadRequest)
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

	bridge.updateTodos(body.Todos)
	writeJSON(w, http.StatusOK, map[string]any{"success": true})
}

func (b *hostPiBridge) updateTodos(todos []any) {
	if todos == nil {
		todos = []any{}
	}
	b.sendEvent(map[string]any{
		"type":  "todo_state",
		"todos": todos,
	})
}

func (b *hostPiBridge) askUserQuestions(ctx context.Context, questions []any, toolCallID string) (map[string]any, error) {
	if len(questions) == 0 {
		return nil, errors.New("questions required")
	}
	if len(questions) > 4 {
		return nil, errors.New("at most 4 questions are supported")
	}

	questionID := fmt.Sprintf("q_%d_%s", time.Now().UnixMilli(), randomID())
	resultCh := make(chan hostPiQuestionResult, 1)

	b.mu.Lock()
	b.questions[questionID] = resultCh
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.questions, questionID)
		b.mu.Unlock()
	}()

	event := map[string]any{
		"type":       "ask_user_question",
		"questionId": questionID,
		"questions":  questions,
	}
	if strings.TrimSpace(toolCallID) != "" {
		event["toolUseId"] = strings.TrimSpace(toolCallID)
	}
	b.sendEvent(event)

	select {
	case result := <-resultCh:
		if result.err != nil {
			return nil, result.err
		}
		if result.answers == nil {
			return map[string]any{}, nil
		}
		b.sendEvent(map[string]any{"type": "question_answered", "questionId": questionID})
		return result.answers, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-b.ctx.Done():
		return nil, errors.New("host Pi chat session closed")
	}
}

func (b *hostPiBridge) answerQuestion(questionID string, answers map[string]any) {
	b.mu.Lock()
	resultCh := b.questions[questionID]
	b.mu.Unlock()
	if resultCh == nil {
		return
	}
	resultCh <- hostPiQuestionResult{answers: answers}
}

func (b *hostPiBridge) failPendingQuestions(message string) {
	b.mu.Lock()
	pending := make([]chan hostPiQuestionResult, 0, len(b.questions))
	for questionID, resultCh := range b.questions {
		pending = append(pending, resultCh)
		delete(b.questions, questionID)
	}
	b.mu.Unlock()

	err := errors.New(message)
	for _, resultCh := range pending {
		resultCh <- hostPiQuestionResult{err: err}
	}
}

func cloneAnyMap(value map[string]any) map[string]any {
	if value == nil {
		return nil
	}
	cloned := make(map[string]any, len(value))
	for key, entry := range value {
		cloned[key] = entry
	}
	return cloned
}

func piToolArgs(event map[string]any) map[string]any {
	for _, key := range []string{"args", "input", "arguments"} {
		if args, ok := event[key].(map[string]any); ok {
			return cloneAnyMap(args)
		}
	}
	return nil
}

func (b *hostPiBridge) rememberToolArgs(toolID string, args map[string]any) map[string]any {
	if toolID == "" {
		return args
	}
	if args == nil {
		args = map[string]any{}
	}
	b.mu.Lock()
	if b.toolArgs == nil {
		b.toolArgs = make(map[string]map[string]any)
	}
	if existing := cloneAnyMap(b.toolArgs[toolID]); existing != nil {
		for key, value := range args {
			existing[key] = value
		}
		args = existing
	}
	if len(args) > 0 {
		b.toolArgs[toolID] = cloneAnyMap(args)
	}
	b.mu.Unlock()
	return args
}

func (b *hostPiBridge) recallToolArgs(toolID string, args map[string]any) map[string]any {
	if toolID == "" {
		return args
	}
	if len(args) > 0 {
		return b.rememberToolArgs(toolID, args)
	}
	b.mu.Lock()
	remembered := cloneAnyMap(b.toolArgs[toolID])
	delete(b.toolArgs, toolID)
	b.mu.Unlock()
	if remembered != nil {
		return remembered
	}
	return map[string]any{}
}

func (b *hostPiBridge) handlePiToolStart(event map[string]any) {
	toolID := stringValue(event["toolCallId"], "pi_tool_"+randomID())
	toolName := stringValue(event["toolName"], "tool")
	args := b.rememberToolArgs(toolID, piToolArgs(event))
	item := map[string]any{
		"id":        toolID,
		"type":      "dynamicToolCall",
		"tool":      toolName,
		"arguments": args,
		"status":    "running",
	}
	if strings.EqualFold(toolName, "bash") {
		item = map[string]any{
			"id":      toolID,
			"type":    "commandExecution",
			"command": stringValue(args["command"], ""),
			"cwd":     args["cwd"],
			"status":  "running",
		}
		if description := stringValue(args["description"], ""); description != "" {
			item["description"] = description
		}
	}
	b.sendRuntimeEvent("item/started", map[string]any{"threadId": b.threadID, "item": item})
}

func (b *hostPiBridge) handlePiToolUpdate(event map[string]any) {
	toolID := stringValue(event["toolCallId"], "")
	if toolID == "" {
		return
	}
	delta := extractPiText(event["partialResult"])
	if delta == "" {
		return
	}
	b.sendRuntimeEvent("item/commandExecution/outputDelta", map[string]any{
		"threadId": b.threadID,
		"itemId":   toolID,
		"delta":    delta,
	})
}

func (b *hostPiBridge) handlePiToolEnd(event map[string]any) {
	toolID := stringValue(event["toolCallId"], "pi_tool_"+randomID())
	toolName := stringValue(event["toolName"], "tool")
	args := b.recallToolArgs(toolID, piToolArgs(event))
	resultText := extractPiText(event["result"])
	status := "completed"
	if isError, _ := event["isError"].(bool); isError {
		status = "failed"
	}
	item := map[string]any{
		"id":        toolID,
		"type":      "dynamicToolCall",
		"tool":      toolName,
		"arguments": args,
		"status":    status,
		"result":    resultText,
	}
	if strings.EqualFold(toolName, "bash") {
		item = map[string]any{
			"id":               toolID,
			"type":             "commandExecution",
			"command":          stringValue(args["command"], ""),
			"cwd":              args["cwd"],
			"status":           status,
			"aggregatedOutput": resultText,
		}
		if description := stringValue(args["description"], ""); description != "" {
			item["description"] = description
		}
	}
	b.sendRuntimeEvent("item/completed", map[string]any{"threadId": b.threadID, "item": item})
}

func (b *hostPiBridge) sendRuntimeEvent(method string, params map[string]any) {
	b.sendEvent(map[string]any{
		"type": "runtime_event",
		"event": map[string]any{
			"method": method,
			"params": params,
		},
	})
}

func (b *hostPiBridge) sendEvent(payload map[string]any) {
	b.mu.Lock()
	payload["seq"] = b.nextSeq
	b.nextSeq++
	b.mu.Unlock()

	encoded, err := json.Marshal(payload)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if err := b.client.WriteMessage(websocket.TextMessage, encoded); err != nil {
		b.server.trace("host_pi_client_write_failed", map[string]any{
			"threadId": b.threadID,
			"type":     payload["type"],
			"error":    err.Error(),
		})
	}
}

func (b *hostPiBridge) writePiCommand(command map[string]any) error {
	encoded, err := json.Marshal(command)
	if err != nil {
		return err
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stdin == nil {
		return errors.New("host Pi process is not running")
	}
	if _, err := b.stdin.Write(append(encoded, '\n')); err != nil {
		return err
	}
	return nil
}

func (b *hostPiBridge) stopProcess() {
	b.mu.Lock()
	stdin := b.stdin
	cmd := b.cmd
	b.stdin = nil
	b.cmd = nil
	b.mu.Unlock()

	if stdin != nil {
		_ = stdin.Close()
	}
	if cmd != nil && cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

func mapStringValues(value any) map[string]string {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	out := make(map[string]string, len(raw))
	for key, value := range raw {
		if str, ok := value.(string); ok {
			out[key] = str
		}
	}
	return out
}

func numberAsInt64(value any) (int64, bool) {
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

func stringValue(value any, fallback string) string {
	if str, ok := value.(string); ok && str != "" {
		return str
	}
	return fallback
}

func piContentIndex(event map[string]any) int {
	if value, ok := numberAsInt64(event["contentIndex"]); ok && value > 0 {
		return int(value)
	}
	return 0
}

func stringifyJSON(value any) string {
	if value == nil {
		return "Pi command failed"
	}
	if str, ok := value.(string); ok {
		return str
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprint(value)
	}
	return string(encoded)
}

func extractPiText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			if text := extractPiText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	case map[string]any:
		if text, ok := v["text"].(string); ok {
			return text
		}
		if content, ok := v["content"]; ok {
			return extractPiText(content)
		}
		if message, ok := v["message"]; ok {
			return extractPiText(message)
		}
		if result, ok := v["result"]; ok {
			return extractPiText(result)
		}
	}
	return ""
}

func isPiAssistantMessage(message map[string]any) bool {
	role, _ := message["role"].(string)
	return role == "assistant"
}

func extractPiAssistantText(value any) string {
	switch v := value.(type) {
	case []any:
		parts := make([]string, 0, len(v))
		for _, item := range v {
			if text := extractPiAssistantText(item); text != "" {
				parts = append(parts, text)
			}
		}
		return strings.Join(parts, "")
	case map[string]any:
		if message, ok := v["message"].(map[string]any); ok {
			if !isPiAssistantMessage(message) {
				return ""
			}
			return extractPiText(message)
		}
		if isPiAssistantMessage(v) {
			return extractPiText(v)
		}
	}
	return ""
}
