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

	bridge := s.attachHostPiBridge(clientConn, name, route, opts, threadID, threadKey)

	var closeOnce sync.Once
	closeAll := func(code int, reason string) {
		closeOnce.Do(func() {
			log.Printf("[SandboxHost] host Pi websocket detached thread=%s container=%s code=%d reason=%s", threadID, name, code, reason)
			bridge.detachClient(clientConn)

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

const hostPiEventReplayLimit = 512
const hostPiRetryStartGracePeriod = 5 * time.Second

type hostPiBufferedEvent struct {
	Seq     int64
	Encoded []byte
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
	events   []hostPiBufferedEvent
	cmd      *exec.Cmd
	stdin    io.WriteCloser
	started  bool
	active   bool
	finalBuf strings.Builder

	activeItem    string
	activeItemBuf strings.Builder
	reasoningItem string

	pendingRetryCompletion *hostPiPendingRetryCompletion
	pendingRetryTimer      *time.Timer

	askToken  string
	questions map[string]chan hostPiQuestionResult
	toolArgs  map[string]map[string]any

	toolCallProgress map[string]hostPiToolCallProgress
}

type hostPiToolCallProgress struct {
	ToolName        string
	LastLoggedBytes int
	DeltaBytes      int
}

type hostPiPendingRetryCompletion struct {
	FinalText    string
	ErrorMessage string
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
		lastSeq := int64(0)
		if value, ok := numberAsInt64(msg["lastSeq"]); ok {
			lastSeq = value
		}
		b.ensureNextSeqAfter(lastSeq)
		env := mapStringValues(msg["env"])
		if err := b.start(env); err != nil {
			return err
		}
		nextSeq, started, buffered, active := b.lifecycleSnapshot()
		log.Printf("[SandboxHost] host Pi init thread=%s lastSeq=%d nextSeq=%d bufferedEvents=%d started=%t active=%t", b.threadID, lastSeq, nextSeq, buffered, started, active)
		if hostPiShouldReplayBufferedEvents(active) {
			b.replayEventsAfter(lastSeq)
		} else {
			log.Printf("[SandboxHost] host Pi replay skipped inactive thread=%s lastSeq=%d bufferedEvents=%d", b.threadID, lastSeq, buffered)
		}
		b.sendEvent(map[string]any{"type": "session", "sessionId": b.threadID})
		b.sendEvent(map[string]any{"type": "ready"})
	case "ping":
		b.sendEvent(map[string]any{"type": "pong", "ts": msg["ts"]})
	case "message":
		content, _ := msg["content"].(string)
		content = strings.TrimSpace(content)
		if content == "" {
			return nil
		}
		clientMessageID := strings.TrimSpace(stringValue(msg["clientMessageId"], ""))
		active := b.isActive()
		if b.server.IsDraining() && !active {
			b.sendEvent(map[string]any{
				"type":   "error",
				"error":  "Sandbox host is restarting. Please retry after reconnect.",
				"source": "host_pi_drain",
			})
			return nil
		}
		if err := b.start(nil); err != nil {
			return err
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
		if active {
			command["streamingBehavior"] = "steer"
		} else {
			b.beginActiveTurn()
		}
		log.Printf("[SandboxHost] host Pi prompt command thread=%s active=%t contentBytes=%d", b.threadID, active, len(content))
		if err := b.writePiCommand(command); err != nil {
			if !active {
				b.endActiveTurn()
			}
			return err
		}
		if clientMessageID != "" {
			b.sendEvent(map[string]any{
				"type":            "message_accepted",
				"clientMessageId": clientMessageID,
			})
		}
		return nil
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
		_, started, _, _ := b.lifecycleSnapshot()
		if started {
			log.Printf("[SandboxHost] host Pi abort command thread=%s", b.threadID)
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
	if b == nil || b.ctx == nil || b.server == nil || b.server.containers == nil {
		return
	}
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
	startedAt := time.Now()

	go b.readPiStdout(stdout)
	go b.readPiStderr(stderr)
	go func() {
		err := cmd.Wait()
		durationMs := time.Since(startedAt).Milliseconds()
		b.endActiveTurn()
		log.Printf("[SandboxHost] host Pi process exited thread=%s container=%s durationMs=%d err=%v", b.threadID, b.container, durationMs, err)
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
	log.Printf("[SandboxHost] host Pi started thread=%s container=%s model=%s sessionDir=%s workspace=%s", b.threadID, b.container, piModel, sessionDir, workspacePath)
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
		"set_preview",
		"list_apps",
		"set_app_visibility",
		"get_latest_logs",
		"list_scheduled_prompts",
		"create_scheduled_prompt",
		"update_scheduled_prompt",
		"delete_scheduled_prompt",
		"run_scheduled_prompt_now",
		"list_integrations",
		"list_integration_types",
		"create_integration",
		"prompt_connection_setup",
		"capture_bug_report",
		"get_custom_domain",
		"set_custom_domain",
		"remove_custom_domain",
		"retry_custom_domain_hostnames",
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
	inferenceBase := fmt.Sprintf("%s/internal/host-pi/inference/%s", controlBase, threadEscaped)
	containerProxyBase := strings.TrimRight(b.server.containers.ContainerProxyBaseURL(), "/")
	if containerProxyBase != "" {
		containerProxyBase += "/" + threadEscaped
	}

	env["OPENAI_BASE_URL"] = inferenceBase + "/api/openai/v1"
	env["OPENAI_API_KEY"] = "proxy"
	env["OPENAI_PROXY_URL"] = inferenceBase + "/api/openai"
	env["OPENROUTER_BASE_URL"] = inferenceBase + "/api/openrouter/v1"
	env["OPENROUTER_ANTHROPIC_BASE_URL"] = inferenceBase + "/api/claude"
	env["CAMEL_API_KEY"] = "proxy"
	env["ANTHROPIC_BASE_URL"] = inferenceBase + "/api/claude"
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
			log.Printf("[SandboxHost] host Pi response error thread=%s error=%s", b.threadID, stringifyJSON(event["error"]))
			b.endActiveTurn()
			b.sendEvent(map[string]any{
				"type":   "error",
				"error":  stringifyJSON(event["error"]),
				"source": "host_pi_response",
			})
		}
	case "agent_start":
		log.Printf("[SandboxHost] host Pi agent_start thread=%s", b.threadID)
		b.beginActiveTurn()
	case "auto_retry_start":
		b.handlePiAutoRetryStart(event)
	case "auto_retry_end":
		b.handlePiAutoRetryEnd(event)
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
		case "toolcall_start":
			b.logPiToolCallStart(assistantEvent)
			b.handlePiToolCallStart(assistantEvent)
		case "toolcall_delta":
			b.logPiToolCallDelta(assistantEvent)
		case "toolcall_end":
			b.logPiToolCallEnd(assistantEvent)
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
		finalText := b.finalBuf.String()
		b.stateMu.Unlock()
		if retryable, errorMessage := isRetryablePiAgentEnd(event); retryable {
			b.deferRetryableAgentEnd(finalText, errorMessage)
			return
		}
		b.finishPiAgentEnd(finalText, event["messages"])
	}
}

func (b *hostPiBridge) handlePiAutoRetryStart(event map[string]any) {
	attempt := intValue(event["attempt"])
	maxAttempts := intValue(event["maxAttempts"])
	delayMs := intValue(event["delayMs"])
	b.stateMu.Lock()
	hadPending := b.pendingRetryCompletion != nil
	if b.pendingRetryTimer != nil {
		b.pendingRetryTimer.Stop()
		b.pendingRetryTimer = nil
	}
	b.pendingRetryCompletion = nil
	b.active = true
	b.finalBuf.Reset()
	b.activeItemBuf.Reset()
	b.activeItem = fmt.Sprintf("pi_agent_%s", randomID())
	b.reasoningItem = ""
	b.stateMu.Unlock()
	log.Printf("[SandboxHost] host Pi auto_retry_start thread=%s attempt=%d maxAttempts=%d delayMs=%d hadPending=%t", b.threadID, attempt, maxAttempts, delayMs, hadPending)
}

func (b *hostPiBridge) handlePiAutoRetryEnd(event map[string]any) {
	success, _ := event["success"].(bool)
	attempt := intValue(event["attempt"])
	if success {
		log.Printf("[SandboxHost] host Pi auto_retry_end thread=%s success=true attempt=%d", b.threadID, attempt)
		return
	}
	finalError := stringValue(event["finalError"], "Pi auto retry failed")
	b.stateMu.Lock()
	if b.pendingRetryTimer != nil {
		b.pendingRetryTimer.Stop()
		b.pendingRetryTimer = nil
	}
	b.pendingRetryCompletion = nil
	b.active = false
	b.stateMu.Unlock()
	log.Printf("[SandboxHost] host Pi auto_retry_end thread=%s success=false attempt=%d error=%s", b.threadID, attempt, finalError)
	b.sendEvent(map[string]any{
		"type":    "error",
		"error":   finalError,
		"source":  "host_pi_auto_retry",
		"attempt": attempt,
	})
}

func (b *hostPiBridge) deferRetryableAgentEnd(finalText string, errorMessage string) {
	pending := &hostPiPendingRetryCompletion{
		FinalText:    finalText,
		ErrorMessage: errorMessage,
	}
	timer := time.AfterFunc(hostPiRetryStartGracePeriod, func() {
		b.finalizePendingRetryCompletion("retry_start_timeout")
	})

	b.stateMu.Lock()
	if b.pendingRetryTimer != nil {
		b.pendingRetryTimer.Stop()
	}
	b.pendingRetryCompletion = pending
	b.pendingRetryTimer = timer
	b.active = true
	b.stateMu.Unlock()

	log.Printf("[SandboxHost] host Pi agent_end retryable deferred thread=%s finalBytes=%d graceMs=%d error=%s", b.threadID, len(finalText), hostPiRetryStartGracePeriod.Milliseconds(), errorMessage)
}

func (b *hostPiBridge) finalizePendingRetryCompletion(reason string) {
	b.stateMu.Lock()
	pending := b.pendingRetryCompletion
	if pending == nil {
		b.stateMu.Unlock()
		return
	}
	b.pendingRetryCompletion = nil
	b.pendingRetryTimer = nil
	b.active = false
	b.stateMu.Unlock()

	log.Printf("[SandboxHost] host Pi retryable agent_end finalized thread=%s reason=%s finalBytes=%d error=%s", b.threadID, reason, len(pending.FinalText), pending.ErrorMessage)
	b.sendEvent(map[string]any{
		"type":   "error",
		"error":  pending.ErrorMessage,
		"source": "host_pi_retryable_agent_end",
	})
}

func (b *hostPiBridge) finishPiAgentEnd(finalText string, messages any) {
	b.endActiveTurn()
	log.Printf("[SandboxHost] host Pi agent_end thread=%s finalBytes=%d", b.threadID, len(finalText))
	if finalText == "" {
		finalText = extractPiAssistantText(messages)
	}
	if finalText == "" {
		finalText = extractPiAssistantProviderErrorText(messages)
		if finalText != "" {
			b.sendRuntimeEvent("item/completed", map[string]any{
				"threadId": b.threadID,
				"item": map[string]any{
					"id":   fmt.Sprintf("pi_provider_error_%s", randomID()),
					"type": "agentMessage",
					"text": finalText,
				},
			})
		}
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

func (s *Server) attachHostPiBridge(
	client *websocket.Conn,
	name string,
	route WorkspaceRoute,
	opts container.EnsureContainerOptions,
	threadID string,
	threadKey string,
) *hostPiBridge {
	threadID = strings.TrimSpace(threadID)
	s.hostPiMu.Lock()
	defer s.hostPiMu.Unlock()

	if s.hostPiChats == nil {
		s.hostPiChats = make(map[string]*hostPiBridge)
	}

	if existing := s.hostPiChats[threadID]; existing != nil && existing.threadKey == threadKey {
		existing.container = name
		existing.route = route
		existing.opts = opts
		existing.attachClient(client)
		nextSeq, started, buffered, active := existing.lifecycleSnapshot()
		log.Printf("[SandboxHost] host Pi websocket attached existing bridge thread=%s container=%s nextSeq=%d bufferedEvents=%d started=%t active=%t", threadID, name, nextSeq, buffered, started, active)
		s.trace("host_pi_chat_ws_attached_existing", map[string]any{
			"container": name,
			"threadId":  threadID,
			"threadKey": threadKey,
		})
		return existing
	}

	ctx, cancel := context.WithCancel(context.Background())
	bridge := &hostPiBridge{
		server:     s,
		client:     client,
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
	s.hostPiChats[bridge.threadID] = bridge
	log.Printf("[SandboxHost] host Pi bridge created thread=%s container=%s threadKey=%s", threadID, name, threadKey)
	return bridge
}

func (b *hostPiBridge) attachClient(client *websocket.Conn) {
	if client == nil {
		return
	}
	b.mu.Lock()
	previous := b.client
	if previous != nil && previous != client {
		_ = previous.Close()
	}
	b.client = client
	b.mu.Unlock()
}

func (b *hostPiBridge) detachClient(client *websocket.Conn) {
	b.mu.Lock()
	if b.client == client {
		b.client = nil
	}
	nextSeq := b.nextSeq
	buffered := len(b.events)
	b.mu.Unlock()
	log.Printf("[SandboxHost] host Pi client detached thread=%s nextSeq=%d bufferedEvents=%d active=%t", b.threadID, nextSeq, buffered, b.isActive())
	if client != nil {
		_ = client.Close()
	}
}

func (b *hostPiBridge) ensureNextSeqAfter(lastSeq int64) int64 {
	b.mu.Lock()
	defer b.mu.Unlock()
	if lastSeq >= b.nextSeq {
		b.nextSeq = lastSeq + 1
	}
	return b.nextSeq
}

func (b *hostPiBridge) lifecycleSnapshot() (int64, bool, int, bool) {
	b.mu.Lock()
	nextSeq := b.nextSeq
	started := b.started
	buffered := len(b.events)
	b.mu.Unlock()

	b.stateMu.Lock()
	active := b.active
	b.stateMu.Unlock()
	return nextSeq, started, buffered, active
}

func (b *hostPiBridge) isActive() bool {
	b.stateMu.Lock()
	defer b.stateMu.Unlock()
	return b.active
}

func (b *hostPiBridge) beginActiveTurn() {
	b.stateMu.Lock()
	if b.pendingRetryTimer != nil {
		b.pendingRetryTimer.Stop()
		b.pendingRetryTimer = nil
	}
	b.pendingRetryCompletion = nil
	b.active = true
	b.finalBuf.Reset()
	b.activeItemBuf.Reset()
	b.activeItem = fmt.Sprintf("pi_agent_%s", randomID())
	b.reasoningItem = ""
	b.stateMu.Unlock()
}

func (b *hostPiBridge) endActiveTurn() {
	b.stateMu.Lock()
	if b.pendingRetryTimer != nil {
		b.pendingRetryTimer.Stop()
		b.pendingRetryTimer = nil
	}
	b.pendingRetryCompletion = nil
	b.active = false
	b.stateMu.Unlock()
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
	log.Printf("[SandboxHost] host Pi ask_user_question start thread=%s question=%s toolCall=%s count=%d", b.threadID, questionID, strings.TrimSpace(toolCallID), len(questions))
	b.sendEvent(event)

	select {
	case result := <-resultCh:
		if result.err != nil {
			log.Printf("[SandboxHost] host Pi ask_user_question failed thread=%s question=%s error=%v", b.threadID, questionID, result.err)
			return nil, result.err
		}
		if result.answers == nil {
			return map[string]any{}, nil
		}
		log.Printf("[SandboxHost] host Pi ask_user_question answered thread=%s question=%s", b.threadID, questionID)
		b.sendEvent(map[string]any{"type": "question_answered", "questionId": questionID})
		return result.answers, nil
	case <-ctx.Done():
		log.Printf("[SandboxHost] host Pi ask_user_question request context done thread=%s question=%s error=%v", b.threadID, questionID, ctx.Err())
		return nil, ctx.Err()
	case <-b.ctx.Done():
		log.Printf("[SandboxHost] host Pi ask_user_question bridge closed thread=%s question=%s", b.threadID, questionID)
		return nil, errors.New("host Pi chat session closed")
	}
}

func (b *hostPiBridge) answerQuestion(questionID string, answers map[string]any) {
	b.mu.Lock()
	resultCh := b.questions[questionID]
	b.mu.Unlock()
	if resultCh == nil {
		log.Printf("[SandboxHost] host Pi question response ignored thread=%s question=%s", b.threadID, questionID)
		return
	}
	log.Printf("[SandboxHost] host Pi question response received thread=%s question=%s answerKeys=%d", b.threadID, questionID, len(answers))
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

const hostPiToolCallProgressLogIntervalBytes = 16 * 1024

func (b *hostPiBridge) logPiToolCallStart(event map[string]any) {
	toolID, toolName, partialBytes := piAssistantToolCallProgress(event)
	if toolID == "" {
		toolID = fmt.Sprintf("content_%d", piContentIndex(event))
	}
	if toolName == "" {
		toolName = "tool"
	}
	b.mu.Lock()
	if b.toolCallProgress == nil {
		b.toolCallProgress = make(map[string]hostPiToolCallProgress)
	}
	b.toolCallProgress[toolID] = hostPiToolCallProgress{
		ToolName:        toolName,
		LastLoggedBytes: partialBytes,
	}
	b.mu.Unlock()
	log.Printf("[SandboxHost] host Pi toolcall start thread=%s tool=%s toolCall=%s partialBytes=%d", b.threadID, toolName, toolID, partialBytes)
}

func (b *hostPiBridge) logPiToolCallDelta(event map[string]any) {
	toolID, toolName, partialBytes := piAssistantToolCallProgress(event)
	if toolID == "" {
		toolID = fmt.Sprintf("content_%d", piContentIndex(event))
	}
	if toolName == "" {
		toolName = "tool"
	}
	delta, _ := event["delta"].(string)
	shouldLog := false
	totalDeltaBytes := 0
	lastLoggedBytes := 0

	b.mu.Lock()
	if b.toolCallProgress == nil {
		b.toolCallProgress = make(map[string]hostPiToolCallProgress)
	}
	progress := b.toolCallProgress[toolID]
	if progress.ToolName == "" {
		progress.ToolName = toolName
	} else {
		toolName = progress.ToolName
	}
	progress.DeltaBytes += len(delta)
	totalDeltaBytes = progress.DeltaBytes
	if partialBytes <= 0 {
		partialBytes = progress.DeltaBytes
	}
	lastLoggedBytes = progress.LastLoggedBytes
	if partialBytes-progress.LastLoggedBytes >= hostPiToolCallProgressLogIntervalBytes {
		progress.LastLoggedBytes = partialBytes
		shouldLog = true
	}
	b.toolCallProgress[toolID] = progress
	b.mu.Unlock()

	if shouldLog {
		log.Printf("[SandboxHost] host Pi toolcall progress thread=%s tool=%s toolCall=%s partialBytes=%d deltaBytes=%d lastLoggedBytes=%d", b.threadID, toolName, toolID, partialBytes, totalDeltaBytes, lastLoggedBytes)
	}
}

func (b *hostPiBridge) logPiToolCallEnd(event map[string]any) {
	toolID, toolName, partialBytes := piAssistantToolCallProgress(event)
	if toolID == "" {
		toolID = fmt.Sprintf("content_%d", piContentIndex(event))
	}
	if toolName == "" {
		toolName = "tool"
	}

	b.mu.Lock()
	progress := b.toolCallProgress[toolID]
	if b.toolCallProgress != nil {
		delete(b.toolCallProgress, toolID)
	}
	b.mu.Unlock()
	if progress.ToolName != "" {
		toolName = progress.ToolName
	}

	if partialBytes <= 0 {
		partialBytes = progress.DeltaBytes
	}
	log.Printf("[SandboxHost] host Pi toolcall end thread=%s tool=%s toolCall=%s partialBytes=%d deltaBytes=%d", b.threadID, toolName, toolID, partialBytes, progress.DeltaBytes)
}

func piAssistantToolCallProgress(event map[string]any) (toolID string, toolName string, partialBytes int) {
	if toolCall, ok := event["toolCall"].(map[string]any); ok {
		toolID = stringValue(toolCall["id"], "")
		toolName = stringValue(toolCall["name"], "")
		if args, ok := toolCall["arguments"].(map[string]any); ok {
			if encoded, err := json.Marshal(args); err == nil {
				partialBytes = len(encoded)
			}
		}
		return toolID, toolName, partialBytes
	}

	partial, _ := event["partial"].(map[string]any)
	content, _ := partial["content"].([]any)
	contentIndex := piContentIndex(event)
	if contentIndex < len(content) {
		if block, ok := content[contentIndex].(map[string]any); ok {
			toolID = stringValue(block["id"], "")
			toolName = stringValue(block["name"], "")
			if partialJSON := stringValue(block["partialJson"], ""); partialJSON != "" {
				partialBytes = len(partialJSON)
			} else if args, ok := block["arguments"].(map[string]any); ok {
				if encoded, err := json.Marshal(args); err == nil {
					partialBytes = len(encoded)
				}
			}
		}
	}

	return toolID, toolName, partialBytes
}

func hostPiRuntimeToolItem(toolID string, toolName string, args map[string]any, status string) map[string]any {
	if args == nil {
		args = map[string]any{}
	}
	if status == "" {
		status = "running"
	}
	item := map[string]any{
		"id":        toolID,
		"type":      "dynamicToolCall",
		"tool":      toolName,
		"arguments": args,
		"status":    status,
	}
	if strings.EqualFold(toolName, "bash") {
		item = map[string]any{
			"id":      toolID,
			"type":    "commandExecution",
			"command": stringValue(args["command"], ""),
			"cwd":     args["cwd"],
			"status":  status,
		}
		if description := stringValue(args["description"], ""); description != "" {
			item["description"] = description
		}
	}
	return item
}

func (b *hostPiBridge) handlePiToolCallStart(event map[string]any) {
	toolID, toolName, _ := piAssistantToolCallProgress(event)
	if toolID == "" {
		return
	}
	if toolName == "" {
		toolName = "tool"
	}
	b.sendRuntimeEvent("item/started", map[string]any{
		"threadId": b.threadID,
		"item":     hostPiRuntimeToolItem(toolID, toolName, nil, "running"),
	})
}

func (b *hostPiBridge) handlePiToolStart(event map[string]any) {
	toolID := stringValue(event["toolCallId"], "pi_tool_"+randomID())
	toolName := stringValue(event["toolName"], "tool")
	args := b.rememberToolArgs(toolID, piToolArgs(event))
	log.Printf("[SandboxHost] host Pi tool start thread=%s tool=%s toolCall=%s", b.threadID, toolName, toolID)
	item := hostPiRuntimeToolItem(toolID, toolName, args, "running")
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
	log.Printf("[SandboxHost] host Pi tool end thread=%s tool=%s toolCall=%s status=%s resultBytes=%d", b.threadID, toolName, toolID, status, len(resultText))
	item := map[string]any{
		"id":        toolID,
		"type":      "dynamicToolCall",
		"tool":      toolName,
		"arguments": args,
		"status":    status,
		"result":    resultText,
	}
	if strings.EqualFold(toolName, "bash") {
		item = hostPiRuntimeToolItem(toolID, toolName, args, status)
		item["aggregatedOutput"] = resultText
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
	seq := b.nextSeq
	b.nextSeq++
	encoded, err := json.Marshal(payload)
	if err != nil {
		b.mu.Unlock()
		return
	}
	b.events = append(b.events, hostPiBufferedEvent{Seq: seq, Encoded: encoded})
	if len(b.events) > hostPiEventReplayLimit {
		b.events = append([]hostPiBufferedEvent(nil), b.events[len(b.events)-hostPiEventReplayLimit:]...)
	}
	buffered := len(b.events)
	client := b.client
	if client == nil {
		b.mu.Unlock()
		if kind, ok := loggableHostPiEventKind(payload); ok {
			log.Printf("[SandboxHost] host Pi event buffered without client thread=%s seq=%d kind=%s bufferedEvents=%d", b.threadID, seq, kind, buffered)
		}
		return
	}
	if err := client.WriteMessage(websocket.TextMessage, encoded); err != nil {
		if b.client == client {
			b.client = nil
		}
		b.mu.Unlock()
		log.Printf("[SandboxHost] host Pi client write failed thread=%s seq=%d type=%s error=%v", b.threadID, seq, stringValue(payload["type"], ""), err)
		b.server.trace("host_pi_client_write_failed", map[string]any{
			"threadId": b.threadID,
			"type":     payload["type"],
			"error":    err.Error(),
		})
		_ = client.Close()
		return
	}
	b.mu.Unlock()
}

func (b *hostPiBridge) replayEventsAfter(lastSeq int64) {
	b.mu.Lock()
	client := b.client
	if client == nil {
		b.mu.Unlock()
		log.Printf("[SandboxHost] host Pi replay skipped no client thread=%s lastSeq=%d", b.threadID, lastSeq)
		return
	}
	events := make([]hostPiBufferedEvent, 0, len(b.events))
	for _, event := range b.events {
		if event.Seq > lastSeq {
			events = append(events, event)
		}
	}
	buffered := len(b.events)
	log.Printf("[SandboxHost] host Pi replay start thread=%s lastSeq=%d replayEvents=%d bufferedEvents=%d", b.threadID, lastSeq, len(events), buffered)
	for _, event := range events {
		if err := client.WriteMessage(websocket.TextMessage, event.Encoded); err != nil {
			if b.client == client {
				b.client = nil
			}
			b.mu.Unlock()
			log.Printf("[SandboxHost] host Pi replay failed thread=%s seq=%d error=%v", b.threadID, event.Seq, err)
			b.server.trace("host_pi_client_replay_failed", map[string]any{
				"threadId": b.threadID,
				"seq":      event.Seq,
				"error":    err.Error(),
			})
			_ = client.Close()
			return
		}
	}
	b.mu.Unlock()
	log.Printf("[SandboxHost] host Pi replay complete thread=%s lastSeq=%d replayEvents=%d", b.threadID, lastSeq, len(events))
}

func hostPiShouldReplayBufferedEvents(active bool) bool {
	return active
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
	log.Printf("[SandboxHost] host Pi command sent thread=%s commandType=%s commandId=%s bytes=%d", b.threadID, stringValue(command["type"], ""), stringValue(command["id"], ""), len(encoded))
	return nil
}

func loggableHostPiEventKind(payload map[string]any) (string, bool) {
	eventType := stringValue(payload["type"], "")
	if eventType == "" {
		return "", false
	}
	if eventType != "runtime_event" {
		switch eventType {
		case "session", "ready", "pong":
			return "", false
		default:
			return eventType, true
		}
	}

	event, _ := payload["event"].(map[string]any)
	method := stringValue(event["method"], "")
	switch method {
	case "", "item/agentMessage/delta", "item/reasoning/textDelta", "item/commandExecution/outputDelta":
		return "", false
	default:
		return "runtime_event:" + method, true
	}
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

func intValue(value any) int {
	if n, ok := numberAsInt64(value); ok {
		return int(n)
	}
	return 0
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

func isRetryablePiAgentEnd(event map[string]any) (bool, string) {
	messages, ok := event["messages"].([]any)
	if !ok {
		return false, ""
	}
	for i := len(messages) - 1; i >= 0; i-- {
		message, ok := messages[i].(map[string]any)
		if !ok || stringValue(message["role"], "") != "assistant" {
			continue
		}
		if stringValue(message["stopReason"], "") != "error" {
			return false, ""
		}
		errorMessage := stringValue(message["errorMessage"], "")
		return isRetryablePiErrorMessage(errorMessage), errorMessage
	}
	return false, ""
}

func isRetryablePiErrorMessage(message string) bool {
	normalized := strings.ToLower(message)
	if normalized == "" {
		return false
	}
	if strings.Contains(normalized, "context") &&
		(strings.Contains(normalized, "overflow") ||
			strings.Contains(normalized, "length") ||
			strings.Contains(normalized, "window") ||
			strings.Contains(normalized, "token")) {
		return false
	}
	retryablePatterns := []string{
		"overloaded",
		"provider returned error",
		"provider-returned-error",
		"rate limit",
		"ratelimit",
		"too many requests",
		"429",
		"500",
		"502",
		"503",
		"504",
		"service unavailable",
		"server error",
		"internal error",
		"network error",
		"connection error",
		"connection refused",
		"connection lost",
		"websocket closed",
		"websocket error",
		"other side closed",
		"fetch failed",
		"upstream connect",
		"reset before headers",
		"socket hang up",
		"ended without",
		"http2 request did not get a response",
		"timed out",
		"timeout",
		"terminated",
		"retry delay",
	}
	for _, pattern := range retryablePatterns {
		if strings.Contains(normalized, pattern) {
			return true
		}
	}
	return false
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

func extractPiAssistantProviderErrorText(value any) string {
	switch v := value.(type) {
	case []any:
		for i := len(v) - 1; i >= 0; i-- {
			if text := extractPiAssistantProviderErrorText(v[i]); text != "" {
				return text
			}
		}
	case map[string]any:
		if message, ok := v["message"].(map[string]any); ok {
			if !isPiAssistantMessage(message) {
				return ""
			}
			return piAssistantProviderErrorText(message)
		}
		if isPiAssistantMessage(v) {
			return piAssistantProviderErrorText(v)
		}
	}
	return ""
}
