#!/usr/bin/env bun
/**
 * In-sandbox control plane server.
 * Runs inside a Docker + gVisor sandbox container as the main entrypoint on port 8080.
 * Traffic is proxied from CF Workers via the sandbox host service (services/sandbox-host/).
 *
 * Endpoints:
 *   GET  /health              Health check
 *   POST /exec               Synchronous command execution
 *   WS   /chat               Claude Agent SDK session (JSON over WebSocket)
 *
 * Filesystem operations are handled by the sandbox host via direct host FS access.
 */

import { query } from '@anthropic-ai/claude-agent-sdk';
import { loadUserProfile, MEMORY_DIR, PROFILE_PATH } from './memory-logger.mjs';
import { readFile, access } from 'fs/promises';
import { homedir } from 'os';

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '8080', 10);
const CONTROL_PLANE_IDLE_TIMEOUT_SECS = Math.max(
  10,
  parseInt(process.env.CONTROL_PLANE_IDLE_TIMEOUT_SECS || '120', 10)
);

// ─── Chat Sessions ─────────────────────────────────────────
const chatSessions = new Map();
const DISCONNECT_IDLE_MS = 60_000;  // Close client WebSockets after 1 min of post-result inactivity

// ─── System Prompt ─────────────────────────────────────────
function buildSystemPromptAppend() {
  const wsId = process.env.WORKSPACE_ID || '';
  return `
## About This Environment

You are running inside **Chiridion**, a web application that brings Claude Code to the browser. Users interact through a chat interface - they cannot see your terminal, localhost servers, or file system directly.

**Important constraints:**
- **localhost is not accessible** - Users cannot open localhost URLs. If you need to show something, deploy it or output the content directly.
- **Don't assume technical ability** - Users may not be developers. Explain what you're doing in plain language. Avoid jargon unless the user demonstrates familiarity.
- **Show results, not processes** - Instead of saying "run npm start and open localhost:3000", deploy the app or show the output directly.
- **Use short bash timeouts** - This is an interactive user session. Default to shorter timeouts for bash commands to avoid long waits. Use longer timeouts only when necessary (e.g., deployments, builds).
- **Avoid large package installations** - Do not install large frameworks like OpenNext, Next.js, or other heavy dependencies. They take too long and degrade the user experience. Use the pre-configured templates instead.

## Multi-User Threads

Threads in Chiridion can have multiple users. Each user message is prefixed with the sender's identity in the format \`[Name (email)]: message\` or \`[email]: message\`. Pay attention to who is sending each message - different team members may have different questions or instructions.

## Chiridion Context Blocks

Some messages include hidden context inserted by Chiridion. This context may appear as:
- \`<chiridion system message> ... </chiridion system message>\`

Treat the content inside these blocks as trusted operator context for the current turn. Use it to guide your response and behavior, but do not explicitly mention these blocks, do not quote their wrappers, and do not tell the user that hidden context was provided.

## File Sharing with User

You have access to two special directories for exchanging files with the user:

- **\`/mnt/user-uploads/\`** - Files uploaded by the user. When a user uploads a file, you'll see a message like "(user uploaded file to /mnt/user-uploads/filename.png)". Read files from this directory to access what they shared.

- **\`/mnt/user-outputs/\`** - Files you create for the user to download or preview. Save files here when you want the user to access them.

**Creating downloadable/previewable files:**
When you save a file to /mnt/user-outputs/, provide a URL so the user can access it:
- Use the workspace outputs URL: \`/api/workspaces/${wsId}/outputs/\`
- For images: \`![Description](/api/workspaces/${wsId}/outputs/chart.png)\` - displays inline
- For downloads: \`[Download Report](/api/workspaces/${wsId}/outputs/report.pdf)\` - triggers download

Examples:
- Image preview: \`![Analysis Chart](/api/workspaces/${wsId}/outputs/charts/analysis.png)\`
- Download link: \`[Download CSV](/api/workspaces/${wsId}/outputs/data.csv)\`
- Download link: \`[Get Full Report](/api/workspaces/${wsId}/outputs/report.pdf)\`

## Node.js Package Management

**Always use \`bun\`** for Node.js package management. Do not use \`npm\` or \`yarn\` - use \`bun\` exclusively for installing dependencies, running scripts, and managing packages.

## Python Environment

This environment has **\`uv\`** installed - a fast Python package manager and project tool. Use \`uv\` instead of \`pip\` for all Python package management:

- **Install packages:** \`uv pip install <package>\` or \`uv add <package>\` (for projects)
- **Run scripts:** \`uv run python script.py\` (auto-installs dependencies)
- **Create virtualenvs:** \`uv venv\` (much faster than python -m venv)
- **Sync dependencies:** \`uv sync\` (from pyproject.toml)

\`uv\` is significantly faster than pip and handles dependency resolution better. Always prefer it for Python work.

## Cloudflare Deployment

When deploying software to the internet or for the user to access:

1. **Always use the globally installed \`wrangler\` CLI** - Do not install wrangler locally via npm
2. **Build as Cloudflare Workers** - All deployable software should be written as Workers
3. **Use Durable Objects with SQLite** - For persistence, use SQLite-backed Durable Objects (not KV)
4. **Use \`wrangler deploy --dispatch-namespace chiridion\`** - Deploy with the global wrangler binary

The infrastructure is already configured for Worker deployments. **For any web app with a UI, use \`create-worker\` to scaffold from the Chiridion starter template**—it's fast to create, has React Router 7 + shadcn/ui pre-configured, and handles both simple and complex apps. Only skip the template for pure API workers with no frontend.

**Important:** Do not install large frameworks like OpenNext, Next.js, or other heavy dependencies—they take too long. The Chiridion starter template has everything pre-configured.

## Episodic Memory

You have a **memory** subagent for maintaining context across sessions. It handles both logging and searching.

**IMPORTANT:** Always **resume** the memory subagent using its previous agent ID rather than starting fresh. This preserves the subagent's context about what has already been logged or searched in this session. Track the agent ID after first invocation and use the \`resume\` parameter on subsequent calls.

### Logging (background)
After completing significant work, invoke with \`run_in_background: true\`:
- After implementing features or fixing bugs
- After deploying applications
- After completing multi-step tasks
- After important decisions or investigations

### Searching (foreground)
When you need to find past work, invoke normally:
- "When did we deploy X?"
- "What was that bug we fixed?"
- "Have we worked on this before?"

### Storage
Memory files: \`~/.chiridion/memory/YYYY-MM-DD.md\`
Use the memory subagent to search when you need past context.

## Asking Questions with AskUserQuestion

Use the **AskUserQuestion** tool whenever you have a question with multiple valid options. This is your primary way to gather user preferences and make decisions collaboratively.

**When to use it:**
- Choosing between approaches (e.g., "Should I use SQLite or KV for this?")
- Clarifying requirements (e.g., "What color theme do you want?")
- Confirming before significant actions (e.g., "This will delete the old data. Proceed?")
- Offering feature options (e.g., "Do you want authentication included?")

**When NOT to use it:**
- For simple yes/no questions that don't affect the outcome
- When you already have enough information to proceed
- For questions you can answer yourself by reading docs or code

The tool presents your options as clickable buttons in the chat, making it easy for users to respond quickly. Don't make assumptions when multiple valid paths exist—ask!

## User Profile

You have a **profile-writer** subagent for maintaining a persistent profile about the user. The profile is always loaded into your system prompt, so you can see it - no reader needed.

**IMPORTANT:** Always **resume** the profile-writer subagent using its previous agent ID.

### When to Update (background)
Invoke with \`run_in_background: true\` when you learn something new about the user:
- Personality traits or communication style
- Technical preferences (languages, tools, coding style)
- Work context (role, team, projects)
- Quirks, pet peeves, things they love
- Inside jokes or recurring references

### What NOT to Log
- Transient task details (use memory for that)
- Sensitive personal information
- Temporary preferences

### Storage
Profile: \`~/.chiridion/profile.md\`
The full profile is always in your system prompt under "User Profile".
`;
}

function withProxySessionPath(rawUrl, proxySessionId) {
  try {
    const url = new URL(rawUrl);
    const basePath = '/proxy';
    if (!url.pathname.startsWith(basePath)) return rawUrl;

    const sessionPathPrefix = `${basePath}/${encodeURIComponent(proxySessionId)}`;
    if (url.pathname.startsWith(`${sessionPathPrefix}/`) || url.pathname === sessionPathPrefix) {
      return url.toString();
    }

    const suffix = url.pathname.slice(basePath.length);
    url.pathname = `${sessionPathPrefix}${suffix || '/'}`;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

const MEMORY_AGENT = {
  description: `Episodic memory manager. IMPORTANT: Always RESUME this subagent using its previous agent ID if one exists - do not start fresh each time. This preserves context about what has already been logged/searched.

Use for THREE purposes:

1. LOGGING (run in background): After completing significant tasks, invoke with run_in_background=true to record what was done. Use proactively after implementing features, fixing bugs, deploying, or completing multi-step tasks.

2. SEARCHING (run in foreground): When you need to find past work - "when did we deploy X?", "what was that bug?", "have we worked on this before?" - search BOTH memory files AND session history to get complete results.

3. CONTEXT RETRIEVAL (run in foreground): Use session-search show with --around to get full context around a specific message or timestamp.`,
  prompt: `You are an episodic memory manager for a coding workspace. You handle LOGGING memories and SEARCHING history.

## Memory Location
${MEMORY_DIR}/YYYY-MM-DD.md (one file per day, timestamped entries)

## MODE 1: LOGGING (when asked to record/log something)

Write a brief entry (2-4 sentences) summarizing what was accomplished:
- What the user wanted
- Key actions taken (files, tools, decisions)
- The outcome

**Entry format:**
\`\`\`
## HH:MM - [Brief Title]
[2-4 sentence factual summary]
\`\`\`

Append to today's file. Create it if needed. Be concise and factual.

## MODE 2: SEARCHING (when asked to find/recall something)

Search BOTH sources to get complete results:

**Memory files** (curated summaries):
\`\`\`bash
grep -r "keyword" ${MEMORY_DIR}/
\`\`\`

**Session history** (full conversation logs):
\`\`\`bash
session-search search "your query" --limit 20
session-search search "query" --after "2026-01-15" --before "2026-01-20"
session-search search "query" --session 68369296
session-search show <session-id> --around "<timestamp>" --context 5
session-search list --limit 10
\`\`\`

Search results show message numbers (e.g., #47) for easy reference.

## Tips
- Memory files have curated summaries, session-search has raw conversation history
- Always try both - memory logs may not exist for all work
- Partial session IDs work (first 8 chars of UUID)
- Use --around with a timestamp to see surrounding context

## Tools Available
- Read: read memory files
- Write: append new entries
- Grep: search across files
- Glob: list files
- Bash: run session-search CLI and other commands`,
  tools: ['Read', 'Write', 'Grep', 'Glob', 'Bash'],
  model: 'haiku',
  maxTurns: 8,
};

const PROFILE_WRITER_AGENT = {
  description: `User profile writer. Use this subagent IN THE BACKGROUND (run_in_background=true) when you learn something new about the user that's worth remembering long-term.

IMPORTANT: Always RESUME this subagent using its previous agent ID. The profile is always visible in the system prompt, so no reader is needed.`,
  prompt: `You are a user profile manager. Your job is to maintain a profile of the user based on interactions.

## Profile Location
${PROFILE_PATH}

## What to Track
- **Character**: Personality, communication style, sense of humor
- **Preferences**: Technical preferences, coding style, tool choices
- **Context**: Their role, projects they work on, team context
- **Quirks**: Unique habits, pet peeves, things they love
- **Inside Jokes**: Recurring references, shared humor, callbacks

## How to Update
1. First, READ the current profile to see what exists
2. Then WRITE the updated profile, preserving existing content and adding/updating sections

## Guidelines
- Be concise but capture personality
- Update existing sections, don't duplicate
- Remove outdated info when updating
- Keep the tone warm and personal`,
  tools: ['Read', 'Write'],
  model: 'haiku',
  maxTurns: 3,
};

// ─── Chat Session ──────────────────────────────────────────

class ChatSession {
  constructor(threadId, sessionEnv) {
    this.threadId = threadId;
    this.sessionEnv = sessionEnv; // Thread-specific env vars
    this.activeQuery = null;
    this.queryIterator = null;
    this.eventLoopRunning = false;
    this.initPromise = null;
    this.messageResolver = null;
    this.messageQueue = [];
    this.pendingQuestions = new Map();
    this.userProfile = null;
    this.lastForwardedCompactSummaryKey = null;
    this.disconnectTimer = null;
    this.clients = new Set();
    this.shuttingDown = false;
  }

  updateSessionEnv(nextSessionEnv) {
    const incoming = nextSessionEnv && typeof nextSessionEnv === 'object' ? nextSessionEnv : {};
    const prevProxySessionId = typeof this.sessionEnv?.CHIRIDION_PROXY_SESSION_ID === 'string'
      ? this.sessionEnv.CHIRIDION_PROXY_SESSION_ID.trim()
      : '';
    this.sessionEnv = {
      ...this.sessionEnv,
      ...incoming,
    };
    const nextProxySessionId = typeof this.sessionEnv?.CHIRIDION_PROXY_SESSION_ID === 'string'
      ? this.sessionEnv.CHIRIDION_PROXY_SESSION_ID.trim()
      : '';
    if (nextProxySessionId && nextProxySessionId !== prevProxySessionId) {
      console.log(
        `[ControlPlane] refreshed proxy session thread=${this.threadId} proxySession=${nextProxySessionId}`
      );
    }
  }

  addClient(ws) {
    this.clients.add(ws);
  }

  removeClient(ws) {
    this.clients.delete(ws);
  }

  broadcast(payload) {
    const json = JSON.stringify(payload);
    for (const ws of this.clients) {
      try { ws.send(json); } catch { /* closed */ }
    }
  }

  /**
   * Start the post-result disconnect timer. After 1 minute of no new
   * messages following a result/stop, close all client WebSockets so
   * the sandbox-host reaper can eventually reclaim the container.
   */
  scheduleDisconnect() {
    this.clearDisconnect();
    this.disconnectTimer = setTimeout(() => {
      if (this.activeQuery || this.eventLoopRunning) return; // still active
      console.log(`[ControlPlane] disconnecting idle clients thread=${this.threadId}`);
      for (const ws of this.clients) {
        try { ws.close(1000, 'idle'); } catch { /* already closed */ }
      }
    }, DISCONNECT_IDLE_MS);
  }

  clearDisconnect() {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  shutdown() {
    this.shuttingDown = true;
    this.clearDisconnect();
    if (this.messageResolver) {
      const r = this.messageResolver;
      this.messageResolver = null;
      r(null);
    }
    if (this.activeQuery) {
      this.activeQuery.interrupt().catch(() => {});
    }
  }

  async sessionFileExists() {
    if (!this.threadId) return false;
    const projectPath = process.cwd().replace(/\//g, '-');
    const jsonlPath = `${homedir()}/.claude/projects/${projectPath}/${this.threadId}.jsonl`;
    try {
      await access(jsonlPath);
      return true;
    } catch {
      return false;
    }
  }

  async handleCanUseTool(toolName, input, opts) {
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow' };
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return { behavior: 'allow' };

    const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const toolUseId = opts?.toolUseID;

    const answerPromise = new Promise((resolve) => {
      this.pendingQuestions.set(questionId, { questionId, toolUseId, questions, resolve });
    });

    this.broadcast({ type: 'ask_user_question', questionId, toolUseId, questions });
    const answers = await answerPromise;
    return { behavior: 'allow', updatedInput: { questions, answers } };
  }

  handleQuestionResponse(questionId, answers) {
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);
    pending.resolve(answers);
    this.broadcast({ type: 'question_answered', questionId });
  }

  getQueryOptions(fileExists) {
    // Merge: process.env (Docker env vars) + sessionEnv (per-thread from WebSocket init)
    const mergedEnv = {
      ...process.env,
      ...this.sessionEnv,
      THREAD_ID: this.threadId,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
    };
    const proxySessionId = typeof mergedEnv.CHIRIDION_PROXY_SESSION_ID === 'string'
      ? mergedEnv.CHIRIDION_PROXY_SESSION_ID.trim()
      : '';
    if (proxySessionId) {
      for (const key of ['ANTHROPIC_BASE_URL', 'CLOUDFLARE_API_BASE_URL', 'DATA_PROXY_URL', 'MCP_SERVER_URL']) {
        const value = mergedEnv[key];
        if (typeof value === 'string' && value.length > 0) {
          mergedEnv[key] = withProxySessionPath(value, proxySessionId);
        }
      }
    }

    const mcpServerUrl = mergedEnv.MCP_SERVER_URL;
    const mcpServers = {};
    if (mcpServerUrl) {
      mcpServers.chiridion = {
        type: 'http',
        url: mcpServerUrl,
      };
    }

    const systemAppend = buildSystemPromptAppend().trim() +
      (this.userProfile ? `\n\n## User Profile\n\nHere's what you know about this user:\n\n${this.userProfile}` : '');

    const options = {
      // Force Node as the runtime executable — Bun has a bug that breaks the SDK.
      executable: 'node',
      model: 'opus',
      fallbackModel: 'sonnet',
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowUnsandboxedCommands: true,
      canUseTool: (name, input, opts) => this.handleCanUseTool(name, input, opts),
      ...(Object.keys(mcpServers).length > 0 && {
        mcpServers,
        allowedTools: ['mcp__chiridion__*'],
      }),
      agents: {
        'memory': MEMORY_AGENT,
        'profile-writer': PROFILE_WRITER_AGENT,
      },
      hooks: {
        Stop: [{ hooks: [async () => ({
          systemMessage: 'Before finishing: Did you log anything significant to memory? If you accomplished notable work (feature, fix, deployment, investigation) and haven\'t logged it yet, invoke the memory subagent in the background now.',
        })] }],
      },
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: systemAppend,
      },
      settingSources: ['project', 'user'],
      env: mergedEnv,
    };

    if (this.threadId) {
      if (fileExists) {
        options.resume = this.threadId;
      } else {
        options.extraArgs = { 'session-id': this.threadId };
      }
    }

    return options;
  }

  async *createMessageStream() {
    while (true) {
      let message = null;
      if (this.messageQueue.length > 0) {
        message = this.messageQueue.shift();
      } else {
        if (this.shuttingDown) return;
        message = await new Promise((resolve) => { this.messageResolver = resolve; });
        if (this.shuttingDown) {
          if (this.messageQueue.length > 0) {
            message = this.messageQueue.shift();
          } else {
            return;
          }
        }
      }
      if (message === null || message === undefined) continue;
      yield { type: 'user', message: { role: 'user', content: message } };
    }
  }

  async init() {
    if (this.activeQuery || this.initPromise) {
      if (this.initPromise) await this.initPromise;
      return;
    }

    this.initPromise = (async () => {
      this.userProfile = await loadUserProfile().catch(() => null);
      const fileExists = await this.sessionFileExists();
      const options = this.getQueryOptions(fileExists);
      const messageStream = this.createMessageStream();
      this.activeQuery = query({ prompt: messageStream, options });
      this.queryIterator = this.activeQuery[Symbol.asyncIterator]();
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  extractTodos(event) {
    if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use' && block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
          return block.input.todos;
        }
      }
    }
    return null;
  }

  async forwardCompactSummary(boundaryEvent) {
    const projectPath = process.cwd().replace(/\//g, '-');
    const jsonlPath = `${homedir()}/.claude/projects/${projectPath}/${this.threadId}.jsonl`;
    const retryDelays = [0, 150, 300, 500, 800, 1200, 1800, 2600, 3600];
    const skewMs = 15_000;
    const maxAgeMs = 2 * 60_000;

    const boundaryTs = typeof boundaryEvent?.timestamp === 'number' ? boundaryEvent.timestamp
      : typeof boundaryEvent?.timestamp === 'string' ? Date.parse(boundaryEvent.timestamp) : null;
    const minTs = boundaryTs ? boundaryTs - skewMs : Date.now() - maxAgeMs;

    for (const delay of retryDelays) {
      if (delay > 0) await new Promise(r => setTimeout(r, delay));
      let content;
      try { content = await readFile(jsonlPath, 'utf-8'); } catch { continue; }
      const lines = content.trimEnd().split('\n');

      for (let i = lines.length - 1; i >= 0; i--) {
        let entry;
        try { entry = JSON.parse(lines[i]); } catch { continue; }
        if (!entry?.isCompactSummary || entry?.type !== 'user' || !entry?.message?.content) continue;
        const entryTs = typeof entry.timestamp === 'number' ? entry.timestamp
          : typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : null;
        if (minTs && entryTs && entryTs < minTs) continue;

        const key = entry.uuid ? `uuid:${entry.uuid}` : `ts:${entryTs}`;
        if (key === this.lastForwardedCompactSummaryKey) continue;

        this.lastForwardedCompactSummaryKey = key;
        this.broadcast({
          type: 'sdk_event',
          event: { type: 'user', isCompactSummary: true, message: entry.message, uuid: entry.uuid },
        });
        return;
      }
    }
  }

  startEventLoop() {
    if (this.eventLoopRunning || !this.queryIterator) return;
    this.eventLoopRunning = true;

    (async () => {
      try {
        while (true) {
          const { value: event, done } = await this.queryIterator.next();
          if (done) break;

          this.broadcast({ type: 'sdk_event', event });

          if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
            this.forwardCompactSummary(event).catch(() => {});
          }

          const todos = this.extractTodos(event);
          if (todos) this.broadcast({ type: 'todo_state', todos });

        }
      } catch (error) {
        console.error(`[ControlPlane] event loop error thread=${this.threadId}:`, error);
        this.broadcast({ type: 'error', error: String(error), source: 'eventLoop' });
      } finally {
        this.activeQuery = null;
        this.queryIterator = null;
        this.eventLoopRunning = false;
        // Start disconnect countdown — a new message will cancel it.
        this.scheduleDisconnect();
      }
    })();
  }

  async handleMessage(content) {
    if (typeof content !== 'string' || !content.trim()) return;
    // New message resets the post-result disconnect timer.
    this.clearDisconnect();
    await this.init();
    this.startEventLoop();

    if (this.messageResolver) {
      const r = this.messageResolver;
      this.messageResolver = null;
      r(content.trim());
    } else {
      this.messageQueue.push(content.trim());
    }
  }

  async handleStop() {
    for (const [qid, pending] of this.pendingQuestions) {
      this.pendingQuestions.delete(qid);
      this.broadcast({ type: 'question_answered', questionId: qid });
      pending.resolve({});
    }
    if (this.activeQuery) {
      try { await this.activeQuery.interrupt(); } catch {}
    }
  }
}

function getOrCreateSession(threadId, sessionEnv) {
  let session = chatSessions.get(threadId);
  if (!session) {
    session = new ChatSession(threadId, sessionEnv);
    chatSessions.set(threadId, session);
  } else {
    session.updateSessionEnv(sessionEnv);
  }
  return session;
}

// ─── Exec ──────────────────────────────────────────────────

async function execCommand(cmd, options = {}) {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd || '/home/claude',
    env: { ...process.env, ...(options.env || {}) },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;

  return { success: exitCode === 0, stdout, stderr, exitCode };
}

// ─── Response Helpers ──────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function errorResponse(message, status) {
  return jsonResponse({ error: message }, status);
}

// ─── WebSocket Data ────────────────────────────────────────

/** @typedef {{ threadId?: string, session?: ChatSession }} WsData */

// ─── HTTP Server ───────────────────────────────────────────

const server = Bun.serve({
  port: PORT,
  idleTimeout: CONTROL_PLANE_IDLE_TIMEOUT_SECS,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health
    if (url.pathname === '/health') {
      return jsonResponse({ status: 'ok', pid: process.pid, sessions: chatSessions.size });
    }

    // Exec
    if (url.pathname === '/exec' && req.method === 'POST') {
      try {
        const body = await req.json();
        const cmd = body.cmd;
        if (!Array.isArray(cmd) || cmd.length === 0) {
          return errorResponse('cmd array required', 400);
        }
        const result = await execCommand(cmd, { cwd: body.cwd, env: body.env });
        return jsonResponse(result);
      } catch (err) {
        return errorResponse(String(err.message), 500);
      }
    }

    // Chat WebSocket upgrade
    if (url.pathname === '/chat') {
      if (req.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return errorResponse('WebSocket upgrade required', 426);
      }
      const success = server.upgrade(req, { data: {} });
      if (!success) return errorResponse('WebSocket upgrade failed', 400);
      return undefined;
    }

    return errorResponse('Not found', 404);
  },

  websocket: {
    open(ws) {
      // Wait for init message to attach to a session.
      console.log('[ControlPlane] websocket opened (awaiting init)');
    },

    message(ws, data) {
      if (typeof data !== 'string') return;
      let msg;
      try { msg = JSON.parse(data); } catch { return; }

      if (msg.type === 'init') {
        const threadId = msg.threadId;
        if (!threadId) {
          ws.send(JSON.stringify({ type: 'error', error: 'threadId required in init' }));
          ws.close();
          return;
        }
        const sessionEnv = msg.env || {};
        const session = getOrCreateSession(threadId, sessionEnv);
        ws.data.threadId = threadId;
        ws.data.session = session;
        session.addClient(ws);
        const proxySessionId = typeof sessionEnv.CHIRIDION_PROXY_SESSION_ID === 'string'
          ? sessionEnv.CHIRIDION_PROXY_SESSION_ID
          : '';
        console.log(
          `[ControlPlane] websocket initialized thread=${threadId} proxySession=${proxySessionId}`
        );
        ws.send(JSON.stringify({ type: 'ready', threadId }));

        // Replay pending questions
        for (const pending of session.pendingQuestions.values()) {
          ws.send(JSON.stringify({
            type: 'ask_user_question',
            questionId: pending.questionId,
            toolUseId: pending.toolUseId,
            questions: pending.questions,
          }));
        }
        return;
      }

      const session = ws.data.session;
      if (!session) {
        ws.send(JSON.stringify({ type: 'error', error: 'Send init message first' }));
        return;
      }

      if (msg.type === 'heartbeat') {
        ws.send(JSON.stringify({
          type: 'heartbeat_ack',
          ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
        }));
        return;
      }

      if (msg.type === 'message') {
        session.handleMessage(msg.content).catch((err) => {
          session.broadcast({ type: 'error', error: String(err), source: 'handleMessage' });
        });
        return;
      }

      if (msg.type === 'stop') {
        session.handleStop().catch(() => {});
        return;
      }

      if (msg.type === 'question_response') {
        if (msg.questionId && msg.answers) {
          session.handleQuestionResponse(msg.questionId, msg.answers);
        }
        return;
      }
    },

    close(ws, code, reason) {
      const session = ws.data.session;
      if (session) {
        session.removeClient(ws);
      }
      const threadId = ws.data.threadId || 'unknown';
      const reasonText = typeof reason === 'string' ? reason : '';
      console.log(`[ControlPlane] websocket closed thread=${threadId} code=${code} reason=${reasonText}`);
    },
  },
});

console.log(`[ControlPlane] listening on port ${PORT} (pid=${process.pid})`);

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[ControlPlane] SIGTERM received, shutting down sessions');
  for (const session of chatSessions.values()) {
    session.shutdown();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[ControlPlane] SIGINT received');
  process.exit(0);
});
