package app

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/chiridion/sandbox-host/internal/container"
)

func TestHostPiBridgeResolvePiModel(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		env        map[string]string
		want       string
	}{
		{
			name:       "explicit host model overrides thread selection",
			configured: "custom/provider-model",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "gpt-5.4",
			},
			want: "custom/provider-model",
		},
		{
			name: "codex gpt 5.5",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "gpt-5.5",
			},
			want: "openai/gpt-5.5",
		},
		{
			name: "codex gpt 5.4",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "gpt-5.4",
			},
			want: "openai/gpt-5.4",
		},
		{
			name: "codex gpt 5.4 mini",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "gpt-5.4-mini",
			},
			want: "openai/gpt-5.4-mini",
		},
		{
			name: "codex kimi k2.6",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "kimi-k2.6",
			},
			want: "camel/~moonshotai/kimi-latest",
		},
		{
			name: "codex grok 4.3",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "grok-4.3",
			},
			want: "camel/x-ai/grok-4.3",
		},
		{
			name: "codex gemini 3 flash preview",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "gemini-3-flash-preview",
			},
			want: "camel/google/gemini-3-flash-preview",
		},
		{
			name: "codex gemini 3.1 pro preview",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "gemini-3.1-pro-preview",
			},
			want: "camel/google/gemini-3.1-pro-preview",
		},
		{
			name: "codex deepseek v4 pro",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "deepseek-v4-pro",
			},
			want: "camel/deepseek/deepseek-v4-pro",
		},
		{
			name: "codex deepseek v4 flash",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "codex",
				"CHIRIDION_CODEX_MODEL":   "deepseek-v4-flash",
			},
			want: "camel/deepseek/deepseek-v4-flash",
		},
		{
			name: "claude sonnet",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "claude",
				"CHIRIDION_CLAUDE_MODEL":  "sonnet",
			},
			want: "anthropic/claude-sonnet-4-6",
		},
		{
			name: "claude opus 4.7",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "claude",
				"CHIRIDION_CLAUDE_MODEL":  "opus-4.7",
			},
			want: "anthropic/claude-opus-4-7",
		},
		{
			name: "claude opus",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "claude",
				"CHIRIDION_CLAUDE_MODEL":  "opus",
			},
			want: "anthropic/claude-opus-4-6",
		},
		{
			name: "claude haiku",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "claude",
				"CHIRIDION_CLAUDE_MODEL":  "haiku",
			},
			want: "anthropic/claude-haiku-4-5-20251001",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bridge := &hostPiBridge{server: &Server{cfg: Config{HostPiModel: tt.configured}}}
			if got := bridge.resolvePiModel(tt.env); got != tt.want {
				t.Fatalf("resolvePiModel() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHostPiBridgeRejectsNewIdlePromptWhileDraining(t *testing.T) {
	server := &Server{}
	server.BeginDrain("test")
	bridge := &hostPiBridge{
		server:   server,
		threadID: "thread-1",
		nextSeq:  1,
	}

	if err := bridge.handleClientMessage([]byte(`{"type":"message","content":"hello"}`)); err != nil {
		t.Fatalf("handleClientMessage() returned error: %v", err)
	}
	if bridge.started {
		t.Fatal("expected draining idle prompt to be rejected before starting Pi")
	}
	if len(bridge.events) != 1 {
		t.Fatalf("expected one buffered error event, got %d", len(bridge.events))
	}
	var event map[string]any
	if err := json.Unmarshal(bridge.events[0].Encoded, &event); err != nil {
		t.Fatalf("decode buffered event: %v", err)
	}
	if event["source"] != "host_pi_drain" {
		t.Fatalf("unexpected event: %#v", event)
	}
}

type testWriteCloser struct {
	bytes.Buffer
}

func (w *testWriteCloser) Close() error {
	return nil
}

func TestHostPiBridgeAcknowledgesPromptAfterWrite(t *testing.T) {
	stdin := &testWriteCloser{}
	bridge := &hostPiBridge{
		server:   &Server{},
		threadID: "thread-1",
		nextSeq:  1,
		started:  true,
		stdin:    stdin,
	}

	if err := bridge.handleClientMessage([]byte(`{"type":"message","content":"hello","clientMessageId":"client-1"}`)); err != nil {
		t.Fatalf("handleClientMessage() returned error: %v", err)
	}

	event := hostPiLatestEventOfType(t, bridge, "message_accepted")
	if event == nil {
		t.Fatal("expected message_accepted event")
	}
	if got := event["clientMessageId"]; got != "client-1" {
		t.Fatalf("clientMessageId = %#v, want client-1", got)
	}
	if !strings.Contains(stdin.String(), `"type":"prompt"`) {
		t.Fatalf("expected prompt command to be written, got %q", stdin.String())
	}
}

func TestHostPiBridgeResolvePiModelCommand(t *testing.T) {
	tests := []struct {
		name       string
		configured string
		msg        map[string]any
		want       string
		wantOK     bool
	}{
		{
			name:       "explicit host model overrides requested model",
			configured: "custom/provider-model",
			msg:        map[string]any{"model": "gpt-5.4"},
			want:       "custom/provider-model",
			wantOK:     true,
		},
		{
			name:   "gpt 5.5 maps to built in openai provider",
			msg:    map[string]any{"model": "gpt-5.5"},
			want:   "openai/gpt-5.5",
			wantOK: true,
		},
		{
			name:   "gpt maps to built in openai provider",
			msg:    map[string]any{"model": "gpt-5.4"},
			want:   "openai/gpt-5.4",
			wantOK: true,
		},
		{
			name:   "mini maps to built in openai provider",
			msg:    map[string]any{"model": "gpt-5.4-mini"},
			want:   "openai/gpt-5.4-mini",
			wantOK: true,
		},
		{
			name:   "kimi maps to custom camel provider",
			msg:    map[string]any{"model": "kimi-k2.6"},
			want:   "camel/~moonshotai/kimi-latest",
			wantOK: true,
		},
		{
			name:   "grok maps to custom camel provider",
			msg:    map[string]any{"model": "grok-4.3"},
			want:   "camel/x-ai/grok-4.3",
			wantOK: true,
		},
		{
			name:   "gemini flash maps to custom camel provider",
			msg:    map[string]any{"model": "gemini-3-flash-preview"},
			want:   "camel/google/gemini-3-flash-preview",
			wantOK: true,
		},
		{
			name:   "gemini pro maps to custom camel provider",
			msg:    map[string]any{"model": "gemini-3.1-pro-preview"},
			want:   "camel/google/gemini-3.1-pro-preview",
			wantOK: true,
		},
		{
			name:   "deepseek pro maps to custom camel provider",
			msg:    map[string]any{"model": "deepseek-v4-pro"},
			want:   "camel/deepseek/deepseek-v4-pro",
			wantOK: true,
		},
		{
			name:   "deepseek flash maps to custom camel provider",
			msg:    map[string]any{"model": "deepseek-v4-flash"},
			want:   "camel/deepseek/deepseek-v4-flash",
			wantOK: true,
		},
		{
			name:   "haiku maps to built in anthropic provider",
			msg:    map[string]any{"model": "haiku"},
			want:   "anthropic/claude-haiku-4-5-20251001",
			wantOK: true,
		},
		{
			name:   "sonnet maps to built in anthropic provider",
			msg:    map[string]any{"model": "sonnet"},
			want:   "anthropic/claude-sonnet-4-6",
			wantOK: true,
		},
		{
			name:   "opus 4.7 maps to built in anthropic provider",
			msg:    map[string]any{"model": "opus-4.7"},
			want:   "anthropic/claude-opus-4-7",
			wantOK: true,
		},
		{
			name:   "opus maps to built in anthropic provider",
			msg:    map[string]any{"model": "opus"},
			want:   "anthropic/claude-opus-4-6",
			wantOK: true,
		},
		{
			name:   "canonical pi model is accepted",
			msg:    map[string]any{"model": "openai/gpt-5.4"},
			want:   "openai/gpt-5.4",
			wantOK: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			bridge := &hostPiBridge{server: &Server{cfg: Config{HostPiModel: tt.configured}}}
			got, ok := bridge.resolvePiModelCommand(tt.msg)
			if ok != tt.wantOK {
				t.Fatalf("resolvePiModelCommand() ok = %v, want %v", ok, tt.wantOK)
			}
			if got != tt.want {
				t.Fatalf("resolvePiModelCommand() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestHostPiBridgeOpenRouterUpstreamEnabled(t *testing.T) {
	tests := []struct {
		name string
		cfg  Config
		ctx  *ProxyThreadContext
		want bool
	}{
		{
			name: "hosted gateway enables openrouter upstream",
			cfg:  Config{AIGatewayBaseURL: "https://gateway.example"},
			ctx:  &ProxyThreadContext{},
			want: true,
		},
		{
			name: "openrouter byok enables openrouter upstream",
			ctx:  &ProxyThreadContext{ByokOpenRouterKey: "or-key"},
			want: true,
		},
		{
			name: "openai byok disables openrouter upstream",
			cfg:  Config{AIGatewayBaseURL: "https://gateway.example"},
			ctx:  &ProxyThreadContext{ByokOpenAIKey: "openai-key"},
			want: false,
		},
		{
			name: "anthropic byok disables openrouter upstream",
			cfg:  Config{AIGatewayBaseURL: "https://gateway.example"},
			ctx:  &ProxyThreadContext{ByokAnthropicKey: "anthropic-key"},
			want: false,
		},
		{
			name: "bedrock byok disables openrouter upstream",
			cfg:  Config{AIGatewayBaseURL: "https://gateway.example"},
			ctx:  &ProxyThreadContext{ByokBedrockToken: "bedrock-token"},
			want: false,
		},
		{
			name: "missing gateway disables hosted openrouter upstream",
			ctx:  &ProxyThreadContext{},
			want: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := &Server{
				cfg:          tt.cfg,
				proxyThreads: map[string]*ProxyThreadContext{"thread-key": tt.ctx},
			}
			bridge := &hostPiBridge{server: server, threadKey: "thread-key"}
			if got := bridge.openRouterUpstreamEnabled(); got != tt.want {
				t.Fatalf("openRouterUpstreamEnabled() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestHostPiBridgeResolvePiModelUsesOpenRouterWhenUpstreamIsOpenRouter(t *testing.T) {
	server := &Server{
		cfg:          Config{AIGatewayBaseURL: "https://gateway.example"},
		proxyThreads: map[string]*ProxyThreadContext{"thread-key": &ProxyThreadContext{}},
	}
	bridge := &hostPiBridge{server: server, threadKey: "thread-key"}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "codex",
		"CHIRIDION_CODEX_MODEL":   "gpt-5.5",
	}); got != "camel/openai/gpt-5.5" {
		t.Fatalf("resolvePiModel() hosted GPT = %q, want camel/openai/gpt-5.5", got)
	}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "codex",
		"CHIRIDION_CODEX_MODEL":   "gpt-5.4-mini",
	}); got != "camel/openai/gpt-5.4-mini" {
		t.Fatalf("resolvePiModel() hosted GPT mini = %q, want camel/openai/gpt-5.4-mini", got)
	}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "claude",
		"CHIRIDION_CLAUDE_MODEL":  "sonnet",
	}); got != "camel/anthropic/claude-sonnet-4.6" {
		t.Fatalf("resolvePiModel() hosted Claude = %q, want camel/anthropic/claude-sonnet-4.6", got)
	}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "claude",
		"CHIRIDION_CLAUDE_MODEL":  "opus-4.7",
	}); got != "camel/anthropic/claude-opus-4.7" {
		t.Fatalf("resolvePiModel() hosted Opus 4.7 = %q, want camel/anthropic/claude-opus-4.7", got)
	}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "claude",
		"CHIRIDION_CLAUDE_MODEL":  "opus",
	}); got != "camel/anthropic/claude-opus-4.6" {
		t.Fatalf("resolvePiModel() hosted Opus 4.6 = %q, want camel/anthropic/claude-opus-4.6", got)
	}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "claude",
		"CHIRIDION_CLAUDE_MODEL":  "haiku",
	}); got != "camel/anthropic/claude-haiku-4.5" {
		t.Fatalf("resolvePiModel() hosted Haiku = %q, want camel/anthropic/claude-haiku-4.5", got)
	}

	server.proxyThreads["thread-key"] = &ProxyThreadContext{ByokOpenAIKey: "openai-key"}
	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "codex",
		"CHIRIDION_CODEX_MODEL":   "gpt-5.5",
	}); got != "openai/gpt-5.5" {
		t.Fatalf("resolvePiModel() OpenAI BYOK GPT = %q, want openai/gpt-5.5", got)
	}
}

func TestAttachHostPiBridgeReusesThreadBridge(t *testing.T) {
	server := &Server{}
	route := WorkspaceRoute{OrgID: "org-1", WorkspaceID: "ws-1"}
	opts := container.EnsureContainerOptions{OrgID: "org-1", WorkspaceID: "ws-1"}

	first := server.attachHostPiBridge(nil, "container-1", route, opts, "thread-1", "container-1::thread-1")
	if first == nil {
		t.Fatal("expected first bridge")
	}
	defer first.cancel()

	first.sendEvent(map[string]any{"type": "runtime_event"})
	first.detachClient(nil)

	second := server.attachHostPiBridge(nil, "container-1", route, opts, "thread-1", "container-1::thread-1")
	if second != first {
		t.Fatal("expected reconnect to reuse existing host Pi bridge")
	}
	if first.ctx.Err() != nil {
		t.Fatal("expected websocket detach to keep host Pi context alive")
	}
	if first.nextSeq != 2 {
		t.Fatalf("expected sequence to remain on existing bridge, got %d", first.nextSeq)
	}
}

func TestHostPiBridgeBuffersReplayEventsWithoutClient(t *testing.T) {
	bridge := &hostPiBridge{server: &Server{}, nextSeq: 1}
	for i := 0; i < hostPiEventReplayLimit+1; i++ {
		bridge.sendEvent(map[string]any{"type": "runtime_event"})
	}

	if len(bridge.events) != hostPiEventReplayLimit {
		t.Fatalf("buffer length = %d, want %d", len(bridge.events), hostPiEventReplayLimit)
	}
	if bridge.events[0].Seq != 2 {
		t.Fatalf("first retained seq = %d, want 2", bridge.events[0].Seq)
	}
	if bridge.events[len(bridge.events)-1].Seq != int64(hostPiEventReplayLimit+1) {
		t.Fatalf("last retained seq = %d, want %d", bridge.events[len(bridge.events)-1].Seq, hostPiEventReplayLimit+1)
	}
}

func TestHostPiBridgeSkipsReplayWhenInactive(t *testing.T) {
	if hostPiShouldReplayBufferedEvents(false) {
		t.Fatal("inactive bridge should not replay buffered events")
	}
	if !hostPiShouldReplayBufferedEvents(true) {
		t.Fatal("active bridge should replay buffered events")
	}
}

func TestHostPiBridgeEmitsStreamingStateOnActiveLifecycle(t *testing.T) {
	bridge := &hostPiBridge{
		server:   &Server{},
		threadID: "thread-1",
		nextSeq:  1,
	}

	bridge.beginActiveTurn()
	bridge.endActiveTurn()

	payloads := hostPiBufferedPayloads(t, bridge)
	if len(payloads) != 2 {
		t.Fatalf("payload count = %d, want 2 (%#v)", len(payloads), payloads)
	}
	if payloads[0]["type"] != "streaming_state" || payloads[0]["isStreaming"] != true {
		t.Fatalf("first payload = %#v, want streaming_state true", payloads[0])
	}
	if payloads[1]["type"] != "streaming_state" || payloads[1]["isStreaming"] != false {
		t.Fatalf("second payload = %#v, want streaming_state false", payloads[1])
	}
	if completedAt, ok := payloads[1]["completedAt"].(float64); !ok || completedAt <= 0 {
		t.Fatalf("second payload completedAt = %#v, want positive timestamp", payloads[1]["completedAt"])
	}
}

func TestHostPiBridgeInitSendsCurrentStreamingStateWhenInactive(t *testing.T) {
	bridge := &hostPiBridge{
		server:   &Server{},
		threadID: "thread-1",
		nextSeq:  1,
		started:  true,
	}
	bridge.beginActiveTurn()
	bridge.endActiveTurn()

	if err := bridge.handleClientMessage([]byte(`{"type":"init","lastSeq":99}`)); err != nil {
		t.Fatalf("handleClientMessage(init) returned error: %v", err)
	}

	state := hostPiLatestEventOfType(t, bridge, "streaming_state")
	if state == nil {
		t.Fatal("expected init to emit streaming_state")
	}
	if got := state["isStreaming"]; got != false {
		t.Fatalf("init streaming state = %#v, want false", got)
	}
	if completedAt, ok := state["completedAt"].(float64); !ok || completedAt <= 0 {
		t.Fatalf("init streaming state completedAt = %#v, want positive timestamp", state["completedAt"])
	}
	ready := hostPiLatestEventOfType(t, bridge, "ready")
	if ready == nil {
		t.Fatal("expected init to emit ready")
	}
}

func TestHostPiBridgeDefersRetryableAgentEndUntilAutoRetryStarts(t *testing.T) {
	bridge := &hostPiBridge{
		server:   &Server{cfg: Config{HostPiSessionRoot: t.TempDir()}},
		threadID: "thread-1",
		nextSeq:  1,
	}
	bridge.beginActiveTurn()

	bridge.handlePiEvent(map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type":  "text_delta",
			"delta": "failed partial",
		},
	})
	bridge.handlePiEvent(map[string]any{
		"type": "agent_end",
		"messages": []any{
			map[string]any{
				"role":         "assistant",
				"stopReason":   "error",
				"errorMessage": "provider returned error: 503 service unavailable",
			},
		},
	})

	if !bridge.isActive() {
		t.Fatal("expected retryable agent_end to keep the Pi turn active")
	}
	if hostPiHasRuntimeMethod(t, bridge, "turn/completed") {
		t.Fatal("retryable agent_end should not complete the runtime turn before auto retry starts")
	}
	if event := hostPiLatestEventOfType(t, bridge, "result"); event != nil {
		t.Fatalf("retryable agent_end should not emit a result before auto retry starts: %#v", event)
	}

	bridge.handlePiEvent(map[string]any{
		"type":        "auto_retry_start",
		"attempt":     1,
		"maxAttempts": 3,
		"delayMs":     2000,
	})
	bridge.handlePiEvent(map[string]any{
		"type": "message_update",
		"assistantMessageEvent": map[string]any{
			"type":  "text_delta",
			"delta": "retry success",
		},
	})
	bridge.handlePiEvent(map[string]any{
		"type": "agent_end",
		"messages": []any{
			map[string]any{
				"role":       "assistant",
				"stopReason": "stop",
			},
		},
	})

	if bridge.isActive() {
		t.Fatal("expected successful final agent_end to end the active Pi turn")
	}
	if !hostPiHasRuntimeMethod(t, bridge, "turn/completed") {
		t.Fatal("expected successful final agent_end to complete the runtime turn")
	}
	result := hostPiLatestEventOfType(t, bridge, "result")
	if result == nil {
		t.Fatal("expected successful final agent_end to emit result")
	}
	if got := result["result"]; got != "retry success" {
		t.Fatalf("result = %#v, want retry success", got)
	}
}

func TestHostPiBridgeEndsTurnWhenAutoRetryFails(t *testing.T) {
	bridge := &hostPiBridge{
		server:   &Server{},
		threadID: "thread-1",
		nextSeq:  1,
	}
	bridge.beginActiveTurn()
	bridge.handlePiEvent(map[string]any{
		"type": "agent_end",
		"messages": []any{
			map[string]any{
				"role":         "assistant",
				"stopReason":   "error",
				"errorMessage": "fetch failed with status 503",
			},
		},
	})
	bridge.handlePiEvent(map[string]any{
		"type":       "auto_retry_end",
		"success":    false,
		"attempt":    3,
		"finalError": "Retry failed after 3 attempts: fetch failed with status 503",
	})

	if bridge.isActive() {
		t.Fatal("expected failed auto retry to end the active Pi turn")
	}
	event := hostPiLatestEventOfType(t, bridge, "error")
	if event == nil {
		t.Fatal("expected failed auto retry to emit an error event")
	}
	if got := event["source"]; got != "host_pi_auto_retry" {
		t.Fatalf("error source = %#v, want host_pi_auto_retry", got)
	}
}

func TestHostPiBridgeCompletesWithProviderErrorMessage(t *testing.T) {
	bridge := &hostPiBridge{
		server:   &Server{cfg: Config{HostPiSessionRoot: t.TempDir()}},
		threadID: "thread-1",
		nextSeq:  1,
	}
	bridge.beginActiveTurn()
	bridge.handlePiEvent(map[string]any{
		"type": "agent_end",
		"messages": []any{
			map[string]any{
				"role":         "assistant",
				"content":      []any{},
				"stopReason":   "error",
				"errorMessage": `403 {"error":{"message":"Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys","code":403}}`,
			},
		},
	})

	if bridge.isActive() {
		t.Fatal("expected provider error agent_end to end the active Pi turn")
	}
	if !hostPiHasRuntimeMethod(t, bridge, "turn/completed") {
		t.Fatal("expected provider error agent_end to complete the runtime turn")
	}
	result := hostPiLatestEventOfType(t, bridge, "result")
	if result == nil {
		t.Fatal("expected provider error agent_end to emit result")
	}
	want := "OpenRouter rejected the request: Key limit exceeded (total limit). Manage it using https://openrouter.ai/settings/keys"
	if got := result["result"]; got != want {
		t.Fatalf("result = %#v, want %q", got, want)
	}
	if !hostPiRuntimeAgentMessageContains(t, bridge, want) {
		t.Fatal("expected provider error to be emitted as an agent message")
	}
}

func TestHostPiSkillArgs(t *testing.T) {
	tests := []struct {
		name string
		path string
		want []string
	}{
		{
			name: "empty path disables skills",
			path: " ",
			want: nil,
		},
		{
			name: "configured path is passed to pi",
			path: " /opt/chiridion-host-pi/skills ",
			want: []string{"--skill", "/opt/chiridion-host-pi/skills"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := hostPiSkillArgs(tt.path)
			if len(got) != len(tt.want) {
				t.Fatalf("hostPiSkillArgs() len = %d, want %d (%v)", len(got), len(tt.want), got)
			}
			for i := range got {
				if got[i] != tt.want[i] {
					t.Fatalf("hostPiSkillArgs()[%d] = %q, want %q", i, got[i], tt.want[i])
				}
			}
		})
	}
}

func hostPiRuntimeAgentMessageContains(t *testing.T, bridge *hostPiBridge, text string) bool {
	t.Helper()
	for _, payload := range hostPiBufferedPayloads(t, bridge) {
		if payload["type"] != "runtime_event" {
			continue
		}
		event, _ := payload["event"].(map[string]any)
		if event["method"] != "item/completed" {
			continue
		}
		params, _ := event["params"].(map[string]any)
		item, _ := params["item"].(map[string]any)
		if item["type"] == "agentMessage" && item["text"] == text {
			return true
		}
	}
	return false
}

func hostPiBufferedPayloads(t *testing.T, bridge *hostPiBridge) []map[string]any {
	t.Helper()
	bridge.mu.Lock()
	encoded := make([][]byte, 0, len(bridge.events))
	for _, event := range bridge.events {
		encoded = append(encoded, append([]byte(nil), event.Encoded...))
	}
	bridge.mu.Unlock()

	payloads := make([]map[string]any, 0, len(encoded))
	for _, raw := range encoded {
		var payload map[string]any
		if err := json.Unmarshal(raw, &payload); err != nil {
			t.Fatalf("decode host Pi buffered event: %v", err)
		}
		payloads = append(payloads, payload)
	}
	return payloads
}

func hostPiHasRuntimeMethod(t *testing.T, bridge *hostPiBridge, method string) bool {
	t.Helper()
	for _, payload := range hostPiBufferedPayloads(t, bridge) {
		if payload["type"] != "runtime_event" {
			continue
		}
		event, _ := payload["event"].(map[string]any)
		if event["method"] == method {
			return true
		}
	}
	return false
}

func hostPiRuntimeItemsForMethod(t *testing.T, bridge *hostPiBridge, method string) []map[string]any {
	t.Helper()
	items := []map[string]any{}
	for _, payload := range hostPiBufferedPayloads(t, bridge) {
		if payload["type"] != "runtime_event" {
			continue
		}
		event, _ := payload["event"].(map[string]any)
		if event["method"] != method {
			continue
		}
		params, _ := event["params"].(map[string]any)
		item, _ := params["item"].(map[string]any)
		if item != nil {
			items = append(items, item)
		}
	}
	return items
}

func hostPiLatestEventOfType(t *testing.T, bridge *hostPiBridge, eventType string) map[string]any {
	t.Helper()
	payloads := hostPiBufferedPayloads(t, bridge)
	for i := len(payloads) - 1; i >= 0; i-- {
		if payloads[i]["type"] == eventType {
			return payloads[i]
		}
	}
	return nil
}

func TestHostPiToolArgsIncludesExtensionTools(t *testing.T) {
	got := hostPiToolArgs()
	if len(got) != 2 {
		t.Fatalf("hostPiToolArgs() len = %d, want 2 (%v)", len(got), got)
	}
	if got[0] != "--tools" {
		t.Fatalf("hostPiToolArgs()[0] = %q, want --tools", got[0])
	}
	for _, want := range []string{
		"read",
		"bash",
		"AskUserQuestion",
		"TodoWrite",
		"Explore",
		"Agent",
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
	} {
		if !strings.Contains(got[1], want) {
			t.Fatalf("hostPiToolArgs() missing %q in %q", want, got[1])
		}
	}
}

func TestHostPiSystemPromptArgs(t *testing.T) {
	got := hostPiSystemPromptArgs("")
	if len(got) != 2 {
		t.Fatalf("hostPiSystemPromptArgs() len = %d, want 2 (%v)", len(got), got)
	}
	if got[0] != "--append-system-prompt" {
		t.Fatalf("hostPiSystemPromptArgs()[0] = %q, want --append-system-prompt", got[0])
	}
	for _, want := range []string{"<camelai_behavior>", "<prohibited_activities>", "AskUserQuestion"} {
		if !strings.Contains(got[1], want) {
			t.Fatalf("system prompt missing %q", want)
		}
	}
	if strings.Contains(got[1], "gives Claude") {
		t.Fatalf("system prompt should be model-neutral")
	}
	if strings.Contains(got[1], "# Project Context") {
		t.Fatalf("system prompt should not include project context without a workspace path")
	}
	if !strings.Contains(got[1], "${WORKSPACE_ID}") {
		t.Fatalf("system prompt should keep WORKSPACE_ID placeholder for prompt caching")
	}
}

func TestHostPiSystemPromptArgsIncludesWorkspaceContext(t *testing.T) {
	workspacePath := t.TempDir()
	if err := os.WriteFile(filepath.Join(workspacePath, "AGENTS.md"), []byte("workspace-only instructions"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := hostPiSystemPromptArgs(workspacePath)
	if len(got) != 2 {
		t.Fatalf("hostPiSystemPromptArgs() len = %d, want 2 (%v)", len(got), got)
	}
	for _, want := range []string{"# Project Context", "## /home/claude/AGENTS.md", "workspace-only instructions"} {
		if !strings.Contains(got[1], want) {
			t.Fatalf("system prompt missing workspace context %q", want)
		}
	}
}

func TestHostPiWorkspaceContextDoesNotReadParentContext(t *testing.T) {
	parent := t.TempDir()
	workspacePath := filepath.Join(parent, "workspaces", "tenant-workspace")
	if err := os.MkdirAll(workspacePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(parent, "AGENTS.md"), []byte("host repo instructions must not leak"), 0o600); err != nil {
		t.Fatal(err)
	}

	got := hostPiWorkspaceContextPrompt(workspacePath)
	if got != "" {
		t.Fatalf("hostPiWorkspaceContextPrompt() = %q, want empty when only parent AGENTS.md exists", got)
	}
}

func TestPiContentIndex(t *testing.T) {
	tests := []struct {
		name  string
		event map[string]any
		want  int
	}{
		{name: "missing defaults to zero", event: map[string]any{}, want: 0},
		{name: "zero stays zero", event: map[string]any{"contentIndex": float64(0)}, want: 0},
		{name: "positive float64", event: map[string]any{"contentIndex": float64(2)}, want: 2},
		{name: "positive int", event: map[string]any{"contentIndex": 3}, want: 3},
		{name: "negative clamps to zero", event: map[string]any{"contentIndex": -1}, want: 0},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := piContentIndex(tt.event); got != tt.want {
				t.Fatalf("piContentIndex() = %d, want %d", got, tt.want)
			}
		})
	}
}

func TestPiAssistantToolCallProgress(t *testing.T) {
	event := map[string]any{
		"contentIndex": float64(1),
		"partial": map[string]any{
			"content": []any{
				map[string]any{"type": "text", "text": "thinking"},
				map[string]any{
					"type":        "toolCall",
					"id":          "functions.write:1|fc_123",
					"name":        "write",
					"partialJson": `{"path":"/home/claude/report.md"}`,
				},
			},
		},
	}

	toolID, toolName, partialBytes := piAssistantToolCallProgress(event)
	if toolID != "functions.write:1|fc_123" {
		t.Fatalf("tool id = %q", toolID)
	}
	if toolName != "write" {
		t.Fatalf("tool name = %q", toolName)
	}
	if partialBytes != len(`{"path":"/home/claude/report.md"}`) {
		t.Fatalf("partial bytes = %d", partialBytes)
	}
}

func TestHostPiBridgeAnswerQuestion(t *testing.T) {
	resultCh := make(chan hostPiQuestionResult, 1)
	bridge := &hostPiBridge{
		questions: map[string]chan hostPiQuestionResult{
			"q_test": resultCh,
		},
	}

	bridge.answerQuestion("q_test", map[string]any{"Choice": "A"})

	result := <-resultCh
	if result.err != nil {
		t.Fatalf("answerQuestion() err = %v", result.err)
	}
	if got := result.answers["Choice"]; got != "A" {
		t.Fatalf("answerQuestion() answer = %v, want A", got)
	}
}

func TestHostPiBridgeFailPendingQuestions(t *testing.T) {
	resultCh := make(chan hostPiQuestionResult, 1)
	bridge := &hostPiBridge{
		questions: map[string]chan hostPiQuestionResult{
			"q_test": resultCh,
		},
	}

	bridge.failPendingQuestions("closed")

	result := <-resultCh
	if result.err == nil || result.err.Error() != "closed" {
		t.Fatalf("failPendingQuestions() err = %v, want closed", result.err)
	}
	if len(bridge.questions) != 0 {
		t.Fatalf("failPendingQuestions() left %d pending questions", len(bridge.questions))
	}
}

func TestHostPiBridgeRecallsToolArgsForEndEvent(t *testing.T) {
	bridge := &hostPiBridge{toolArgs: make(map[string]map[string]any)}

	startArgs := bridge.rememberToolArgs("tool_1", map[string]any{"query": "pi tools"})
	startArgs["query"] = "mutated"
	emptyStartArgs := bridge.rememberToolArgs("tool_1", nil)
	if got := emptyStartArgs["query"]; got != "pi tools" {
		t.Fatalf("rememberToolArgs() with empty args replaced existing query = %v, want pi tools", got)
	}

	endArgs := bridge.recallToolArgs("tool_1", nil)
	if got := endArgs["query"]; got != "pi tools" {
		t.Fatalf("recallToolArgs() query = %v, want pi tools", got)
	}
	if _, ok := bridge.toolArgs["tool_1"]; ok {
		t.Fatal("recallToolArgs() should clear remembered args")
	}
}

func TestHostPiBridgePreservesStructuredToolResult(t *testing.T) {
	bridge := &hostPiBridge{threadID: "thread-1"}
	result := []any{
		map[string]any{"type": "text", "text": "Read image file [image/png]"},
		map[string]any{"type": "image", "data": "abc123", "mimeType": "image/png"},
	}

	bridge.handlePiToolEnd(map[string]any{
		"toolCallId": "tool_read",
		"toolName":   "read",
		"result":     result,
	})

	items := hostPiRuntimeItemsForMethod(t, bridge, "item/completed")
	if len(items) != 1 {
		t.Fatalf("item/completed count = %d, want 1", len(items))
	}
	item := items[0]
	rawResult, ok := item["result"].([]any)
	if !ok || len(rawResult) != 2 {
		t.Fatalf("structured result was not preserved: %#v", item["result"])
	}
	contentItems, ok := item["contentItems"].([]any)
	if !ok || len(contentItems) != 2 {
		t.Fatalf("contentItems = %#v, want text plus image", item["contentItems"])
	}
	imageItem, _ := contentItems[1].(map[string]any)
	if imageItem["type"] != "image" || imageItem["data"] != "abc123" {
		t.Fatalf("image content item was not preserved: %#v", imageItem)
	}
}

func TestHostPiBridgeEmitsEarlyBashToolStarted(t *testing.T) {
	bridge := &hostPiBridge{threadID: "thread-1"}

	bridge.handlePiToolCallStart(map[string]any{
		"toolCall": map[string]any{
			"id":   "tool_bash",
			"name": "bash",
		},
	})

	items := hostPiRuntimeItemsForMethod(t, bridge, "item/started")
	if len(items) != 1 {
		t.Fatalf("item/started count = %d, want 1", len(items))
	}
	item := items[0]
	if item["id"] != "tool_bash" {
		t.Fatalf("item id = %#v, want tool_bash", item["id"])
	}
	if item["type"] != "commandExecution" {
		t.Fatalf("item type = %#v, want commandExecution", item["type"])
	}
	if item["status"] != "running" {
		t.Fatalf("item status = %#v, want running", item["status"])
	}
	if command, ok := item["command"].(string); !ok || command != "" {
		t.Fatalf("item command = %#v, want empty string", item["command"])
	}
}

func TestHostPiBridgeUpdatesEarlyBashToolWithArgs(t *testing.T) {
	bridge := &hostPiBridge{threadID: "thread-1"}

	bridge.handlePiToolCallStart(map[string]any{
		"toolCall": map[string]any{
			"id":   "tool_bash",
			"name": "bash",
		},
	})
	bridge.handlePiToolStart(map[string]any{
		"toolCallId": "tool_bash",
		"toolName":   "bash",
		"args": map[string]any{
			"command":     "bun test",
			"description": "tests",
			"cwd":         "/home/claude",
		},
	})

	items := hostPiRuntimeItemsForMethod(t, bridge, "item/started")
	if len(items) != 2 {
		t.Fatalf("item/started count = %d, want 2", len(items))
	}
	item := items[1]
	if item["id"] != "tool_bash" {
		t.Fatalf("item id = %#v, want tool_bash", item["id"])
	}
	if item["command"] != "bun test" {
		t.Fatalf("item command = %#v, want bun test", item["command"])
	}
	if item["description"] != "tests" {
		t.Fatalf("item description = %#v, want tests", item["description"])
	}
	if item["cwd"] != "/home/claude" {
		t.Fatalf("item cwd = %#v, want /home/claude", item["cwd"])
	}
}
