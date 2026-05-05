package app

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
			name: "claude sonnet",
			env: map[string]string{
				"CHIRIDION_CHAT_PROVIDER": "claude",
				"CHIRIDION_CLAUDE_MODEL":  "sonnet",
			},
			want: "anthropic/claude-sonnet-4-6",
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
		"CHIRIDION_CODEX_MODEL":   "gpt-5.4",
	}); got != "camel/openai/gpt-5.4" {
		t.Fatalf("resolvePiModel() hosted GPT = %q, want camel/openai/gpt-5.4", got)
	}

	if got := bridge.resolvePiModel(map[string]string{
		"CHIRIDION_CHAT_PROVIDER": "claude",
		"CHIRIDION_CLAUDE_MODEL":  "sonnet",
	}); got != "camel/anthropic/claude-sonnet-4.6" {
		t.Fatalf("resolvePiModel() hosted Claude = %q, want camel/anthropic/claude-sonnet-4.6", got)
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
		"CHIRIDION_CODEX_MODEL":   "gpt-5.4",
	}); got != "openai/gpt-5.4" {
		t.Fatalf("resolvePiModel() OpenAI BYOK GPT = %q, want openai/gpt-5.4", got)
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
