# Claude CLI In-Process Hooks Protocol

This document describes how to implement in-process hook callbacks when spawning the Claude CLI directly, bypassing the SDK's process management.

## Overview

The Claude CLI supports a bidirectional JSON protocol over stdin/stdout for:
- Registering hook callbacks during initialization
- Receiving hook execution requests from the CLI
- Responding with hook results

This allows you to intercept tool calls, modify inputs, block dangerous operations, and inject context—all without external hook binaries.

## Protocol Flow

```
Your Process                              Claude CLI
    │                                         │
    │  1. Spawn CLI with --output-format      │
    │     stream-json                         │
    │  ──────────────────────────────────────►│
    │                                         │
    │  2. Send initialize control request     │
    │     with hook callback IDs              │
    │  ──────────────────────────────────────►│
    │                                         │
    │  3. CLI sends control_response          │
    │  ◄──────────────────────────────────────│
    │                                         │
    │  4. Send user message                   │
    │  ──────────────────────────────────────►│
    │                                         │
    │  5. CLI streams events (system,         │
    │     assistant, stream_event, etc.)      │
    │  ◄──────────────────────────────────────│
    │                                         │
    │  6. Before tool execution, CLI sends    │
    │     hook_callback control request       │
    │  ◄──────────────────────────────────────│
    │                                         │
    │  7. You respond with hook result        │
    │  ──────────────────────────────────────►│
    │                                         │
    │  8. CLI continues or blocks based       │
    │     on your response                    │
    │  ◄──────────────────────────────────────│
```

## Message Types

### Control Request (bidirectional)

```typescript
type ControlRequest = {
  type: 'control_request';
  request_id: string;
  request: ControlRequestInner;
};
```

### Control Response (bidirectional)

```typescript
type ControlResponse = {
  type: 'control_response';
  response: {
    request_id: string;
    subtype: 'success' | 'error';
    // ... result fields
  };
};
```

## Initialization

Before sending any user messages, send an initialization control request to register your hooks:

### Request (You → CLI)

```json
{
  "type": "control_request",
  "request_id": "init_001",
  "request": {
    "subtype": "initialize",
    "hooks": {
      "PreToolUse": [
        {
          "matcher": "Bash*",
          "hookCallbackIds": ["hook_bash_pre"],
          "timeout": 30
        },
        {
          "hookCallbackIds": ["hook_all_pre"],
          "timeout": 30
        }
      ],
      "PostToolUse": [
        {
          "hookCallbackIds": ["hook_post"],
          "timeout": 30
        }
      ],
      "SessionStart": [
        {
          "hookCallbackIds": ["hook_session_start"]
        }
      ]
    },
    "systemPrompt": "Optional custom system prompt",
    "appendSystemPrompt": "Optional text to append to default prompt"
  }
}
```

### Response (CLI → You)

```json
{
  "type": "control_response",
  "response": {
    "request_id": "init_001",
    "subtype": "success"
  }
}
```

## Hook Events

| Event | When Called | Can Block? |
|-------|-------------|------------|
| `PreToolUse` | Before tool execution | Yes |
| `PostToolUse` | After successful tool execution | No |
| `PostToolUseFailure` | After tool execution fails | No |
| `UserPromptSubmit` | When user submits a message | Yes |
| `SessionStart` | When session begins | No |
| `SessionEnd` | When session ends | No |
| `Stop` | When execution is stopped | No |
| `SubagentStart` | When a subagent starts | Yes |
| `SubagentStop` | When a subagent stops | No |
| `PreCompact` | Before context compaction | No |
| `PermissionRequest` | When permission is requested | Yes |
| `Setup` | During initial setup | No |

## Hook Callback Request

When the CLI needs to execute a hook, it sends:

### Request (CLI → You)

```json
{
  "type": "control_request",
  "request_id": "hook_req_456",
  "request": {
    "subtype": "hook_callback",
    "callback_id": "hook_bash_pre",
    "input": {
      "hook_event_name": "PreToolUse",
      "session_id": "abc-123",
      "transcript_path": "/home/user/.claude/projects/.../session.jsonl",
      "cwd": "/home/user/project",
      "permission_mode": "bypassPermissions",
      "tool_name": "Bash",
      "tool_input": {
        "command": "rm -rf /important/data"
      },
      "tool_use_id": "tool_789"
    },
    "tool_use_id": "tool_789"
  }
}
```

### Response (You → CLI)

```json
{
  "type": "control_response",
  "response": {
    "request_id": "hook_req_456",
    "subtype": "success",
    "continue": true,
    "hookSpecificOutput": {
      "hookEventName": "PreToolUse",
      "permissionDecision": "deny",
      "permissionDecisionReason": "Dangerous command blocked",
      "additionalContext": "This command would delete important data"
    }
  }
}
```

## Hook-Specific Inputs

### PreToolUse

```typescript
type PreToolUseHookInput = {
  hook_event_name: 'PreToolUse';
  session_id: string;
  transcript_path: string;
  cwd: string;
  permission_mode?: string;
  tool_name: string;
  tool_input: unknown;
  tool_use_id: string;
};
```

### PostToolUse

```typescript
type PostToolUseHookInput = {
  hook_event_name: 'PostToolUse';
  session_id: string;
  transcript_path: string;
  cwd: string;
  tool_name: string;
  tool_input: unknown;
  tool_response: unknown;
  tool_use_id: string;
};
```

### UserPromptSubmit

```typescript
type UserPromptSubmitHookInput = {
  hook_event_name: 'UserPromptSubmit';
  session_id: string;
  transcript_path: string;
  cwd: string;
  prompt: string;
};
```

## Hook-Specific Outputs

### PreToolUse

```typescript
type PreToolUseHookSpecificOutput = {
  hookEventName: 'PreToolUse';
  permissionDecision?: 'allow' | 'deny' | 'ask';
  permissionDecisionReason?: string;
  updatedInput?: Record<string, unknown>;  // Modify tool input
  additionalContext?: string;  // Inject context for Claude
};
```

### PostToolUse

```typescript
type PostToolUseHookSpecificOutput = {
  hookEventName: 'PostToolUse';
  additionalContext?: string;
  updatedMCPToolOutput?: unknown;  // Modify tool output
};
```

### UserPromptSubmit

```typescript
type UserPromptSubmitHookSpecificOutput = {
  hookEventName: 'UserPromptSubmit';
  additionalContext?: string;  // Inject context before processing
};
```

## Common Response Fields

```typescript
type SyncHookJSONOutput = {
  continue?: boolean;           // Whether to continue execution
  suppressOutput?: boolean;     // Suppress hook output in logs
  stopReason?: string;          // Reason for stopping (if continue=false)
  decision?: 'approve' | 'block';  // For permission-related hooks
  systemMessage?: string;       // System message to inject
  reason?: string;              // General reason field
  hookSpecificOutput?: HookSpecificOutput;
};
```

## Matcher Patterns

The `matcher` field in hook registration supports glob patterns:

| Pattern | Matches |
|---------|---------|
| `Bash` | Exactly "Bash" |
| `Bash*` | "Bash", "BashExec", etc. |
| `*Edit` | "Edit", "NotebookEdit", etc. |
| `mcp__*` | All MCP tools |
| (omitted) | All tools |

## Example Implementation

```javascript
import { spawn } from 'child_process';
import readline from 'readline';

class ClaudeWithHooks {
  constructor() {
    this.hookCallbacks = new Map();
    this.pendingResponses = new Map();
    this.nextHookId = 0;
  }

  // Register a hook callback
  onPreToolUse(matcher, callback) {
    const id = `hook_pre_${this.nextHookId++}`;
    this.hookCallbacks.set(id, { event: 'PreToolUse', matcher, callback });
    return this;
  }

  onPostToolUse(callback) {
    const id = `hook_post_${this.nextHookId++}`;
    this.hookCallbacks.set(id, { event: 'PostToolUse', callback });
    return this;
  }

  async start(options = {}) {
    // Spawn CLI with JSON streaming output
    this.process = spawn('claude', [
      '--output-format', 'stream-json',
      '--permission-mode', options.permissionMode || 'default',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env }
    });

    // Handle stderr
    this.process.stderr.on('data', (data) => {
      console.error('[CLI stderr]', data.toString());
    });

    // Parse JSON lines from stdout
    const rl = readline.createInterface({ input: this.process.stdout });

    rl.on('line', async (line) => {
      if (!line.trim()) return;

      try {
        const msg = JSON.parse(line);
        await this.handleMessage(msg);
      } catch (e) {
        console.error('Failed to parse:', line, e);
      }
    });

    // Wait for process to be ready, then initialize
    await new Promise(resolve => setTimeout(resolve, 100));
    await this.initialize();
  }

  async initialize() {
    const hooks = this.buildHooksConfig();

    await this.sendControlRequest({
      subtype: 'initialize',
      hooks: Object.keys(hooks).length > 0 ? hooks : undefined,
    });
  }

  buildHooksConfig() {
    const config = {};

    for (const [id, { event, matcher }] of this.hookCallbacks) {
      if (!config[event]) config[event] = [];

      // Find existing matcher group or create new one
      let group = config[event].find(g => g.matcher === matcher);
      if (!group) {
        group = { hookCallbackIds: [], timeout: 30 };
        if (matcher) group.matcher = matcher;
        config[event].push(group);
      }
      group.hookCallbackIds.push(id);
    }

    return config;
  }

  async handleMessage(msg) {
    if (msg.type === 'control_request') {
      if (msg.request.subtype === 'hook_callback') {
        await this.handleHookCallback(msg);
      }
    } else if (msg.type === 'control_response') {
      const resolver = this.pendingResponses.get(msg.response.request_id);
      if (resolver) {
        this.pendingResponses.delete(msg.response.request_id);
        resolver(msg.response);
      }
    } else {
      // Regular SDK event (system, assistant, stream_event, result, etc.)
      this.onEvent?.(msg);
    }
  }

  async handleHookCallback(msg) {
    const { callback_id, input, tool_use_id } = msg.request;
    const hook = this.hookCallbacks.get(callback_id);

    let result = { continue: true };

    if (hook?.callback) {
      try {
        result = await hook.callback(input, tool_use_id) || { continue: true };
      } catch (e) {
        console.error('Hook callback error:', e);
        result = { continue: true };
      }
    }

    this.write({
      type: 'control_response',
      response: {
        request_id: msg.request_id,
        subtype: 'success',
        ...result
      }
    });
  }

  sendControlRequest(request) {
    const requestId = `req_${Date.now()}_${Math.random().toString(36).slice(2)}`;

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingResponses.delete(requestId);
        reject(new Error('Control request timeout'));
      }, 30000);

      this.pendingResponses.set(requestId, (response) => {
        clearTimeout(timeout);
        if (response.subtype === 'error') {
          reject(new Error(response.error));
        } else {
          resolve(response);
        }
      });

      this.write({
        type: 'control_request',
        request_id: requestId,
        request
      });
    });
  }

  write(msg) {
    this.process.stdin.write(JSON.stringify(msg) + '\n');
  }

  send(content) {
    this.write({
      type: 'user',
      message: { role: 'user', content }
    });
  }

  async interrupt() {
    await this.sendControlRequest({ subtype: 'interrupt' });
  }

  close() {
    this.process?.stdin?.end();
    this.process?.kill();
  }
}

// Usage
const claude = new ClaudeWithHooks();

// Block dangerous commands
claude.onPreToolUse('Bash*', async (input) => {
  const cmd = input.tool_input?.command || '';

  if (cmd.includes('rm -rf') || cmd.includes('sudo')) {
    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: 'Dangerous command blocked by policy'
      }
    };
  }

  return { continue: true };
});

// Log all tool executions
claude.onPostToolUse(async (input) => {
  console.log(`Tool ${input.tool_name} completed:`, input.tool_response);
  return { continue: true };
});

// Handle events
claude.onEvent = (event) => {
  if (event.type === 'assistant') {
    console.log('Assistant:', event.message.content);
  } else if (event.type === 'result') {
    console.log('Done:', event.result);
  }
};

await claude.start({
  env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
});

claude.send('List the files in the current directory');
```

## Async Hooks

For long-running hook operations, return an async marker:

```json
{
  "type": "control_response",
  "response": {
    "request_id": "hook_req_456",
    "subtype": "success",
    "async": true,
    "asyncTimeout": 60
  }
}
```

Then send the actual result when ready (implementation details TBD).

## Error Handling

If your hook fails, you can return an error:

```json
{
  "type": "control_response",
  "response": {
    "request_id": "hook_req_456",
    "subtype": "error",
    "error": "Hook execution failed: connection timeout"
  }
}
```

## Tips

1. **Initialize before sending messages** - The CLI expects initialization before user messages
2. **Handle all hook callbacks** - Unhandled callbacks will timeout
3. **Keep callbacks fast** - Long-running callbacks can slow down the agent
4. **Use matchers wisely** - More specific matchers reduce unnecessary hook calls
5. **Test with `permissionDecision: 'ask'`** - This lets the CLI prompt (if in interactive mode)
