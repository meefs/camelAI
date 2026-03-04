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
import { loadUserProfile } from './memory-logger.mjs';
import { readFile, access } from 'fs/promises';
import { homedir } from 'os';
import { TeamPollingController } from './team-poll-controller.mjs';

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '8080', 10);
const CONTROL_PLANE_IDLE_TIMEOUT_SECS = Math.max(
  10,
  parseInt(process.env.CONTROL_PLANE_IDLE_TIMEOUT_SECS || '120', 10)
);

// ─── Chat Sessions ─────────────────────────────────────────
const chatSessions = new Map();
const DISCONNECT_IDLE_MS = 60_000;  // Close client WebSockets after 1 min of post-result inactivity
const IDLE_DISCONNECT_CLOSE_GRACE_MS = 3_000;
const TRACE_CONTROL_PLANE = process.env.TRACE_CONTROL_PLANE === '1';
const REPLAY_BUFFER_MAX = Math.max(200, parseInt(process.env.CONTROL_PLANE_REPLAY_BUFFER_MAX || '4000', 10));

function traceControlPlane(event, details = {}) {
  if (!TRACE_CONTROL_PLANE) return;
  try {
    console.log(`[ControlPlane][trace] ${event} ${JSON.stringify(details)}`);
  } catch {
    console.log(`[ControlPlane][trace] ${event}`);
  }
}

function initWsDebugState(ws) {
  const now = Date.now();
  ws.data.openedAt = now;
  ws.data.lastInboundAt = now;
  ws.data.lastOutboundAt = now;
  ws.data.inboundCount = 0;
  ws.data.outboundCount = 0;
  ws.data.lastInboundType = '';
  ws.data.lastOutboundType = '';
  ws.data.closeRequestedBy = '';
}

function wsDebugSnapshot(ws) {
  const now = Date.now();
  const openedAt = typeof ws.data.openedAt === 'number' ? ws.data.openedAt : null;
  const lastInboundAt = typeof ws.data.lastInboundAt === 'number' ? ws.data.lastInboundAt : null;
  const lastOutboundAt = typeof ws.data.lastOutboundAt === 'number' ? ws.data.lastOutboundAt : null;
  return {
    threadId: ws.data.threadId || '',
    openedAt,
    uptimeMs: openedAt ? now - openedAt : null,
    lastInboundAt,
    lastOutboundAt,
    sinceLastInboundMs: lastInboundAt ? now - lastInboundAt : null,
    sinceLastOutboundMs: lastOutboundAt ? now - lastOutboundAt : null,
    inboundCount: typeof ws.data.inboundCount === 'number' ? ws.data.inboundCount : 0,
    outboundCount: typeof ws.data.outboundCount === 'number' ? ws.data.outboundCount : 0,
    lastInboundType: ws.data.lastInboundType || '',
    lastOutboundType: ws.data.lastOutboundType || '',
    closeRequestedBy: ws.data.closeRequestedBy || '',
  };
}

function noteInbound(ws, type, bytes) {
  ws.data.lastInboundAt = Date.now();
  ws.data.inboundCount = (typeof ws.data.inboundCount === 'number' ? ws.data.inboundCount : 0) + 1;
  ws.data.lastInboundType = type;
  traceControlPlane('ws_inbound', {
    ...wsDebugSnapshot(ws),
    type,
    bytes,
  });
}

function noteOutbound(ws, type) {
  ws.data.lastOutboundAt = Date.now();
  ws.data.outboundCount = (typeof ws.data.outboundCount === 'number' ? ws.data.outboundCount : 0) + 1;
  ws.data.lastOutboundType = type;
}

function sendWsJson(ws, payload, context) {
  const json = JSON.stringify(payload);
  const payloadType = payload && typeof payload === 'object' && typeof payload.type === 'string'
    ? payload.type
    : 'unknown';
  try {
    ws.send(json);
    noteOutbound(ws, payloadType);
    traceControlPlane('ws_send', {
      ...wsDebugSnapshot(ws),
      context,
      payloadType,
      bytes: json.length,
    });
    return true;
  } catch (err) {
    traceControlPlane('ws_send_failed', {
      ...wsDebugSnapshot(ws),
      context,
      payloadType,
      bytes: json.length,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

function closeWsWithTrace(ws, code, reason, source) {
  ws.data.closeRequestedBy = source;
  traceControlPlane('ws_close_requested', {
    ...wsDebugSnapshot(ws),
    code,
    reason,
    source,
  });
  try {
    ws.close(code, reason);
    return true;
  } catch (err) {
    traceControlPlane('ws_close_request_failed', {
      ...wsDebugSnapshot(ws),
      code,
      reason,
      source,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

// ─── System Prompt ─────────────────────────────────────────
function buildSystemPromptAppend() {
  const wsId = process.env.WORKSPACE_ID || '';
  return `
<camelai_behavior>
<environment>
You are running inside **camelAI**, a web application that gives Claude a persistent computer in the browser. Users interact through a chat interface—they cannot see your terminal, localhost servers, or file system directly.

This is your workspace. Files persist between sessions. You can build, deploy, and maintain software over time. Think of this as your home environment, not a stateless tool invocation.

<filesystem_layout>
\`\`\`
/home/claude/
├── projects/          # Your projects (persistent across sessions)
├── .config/           # Tool configs (wrangler, npm, etc.)
└── .chiridion/        # camelAI-specific data
    └── profile.md     # User profile

/mnt/user-uploads/     # Files uploaded by user (read-only)
/mnt/user-outputs/     # Files for user download (write here)
\`\`\`
</filesystem_layout>

<environment_variables>
| Variable | Purpose |
|----------|---------|
| \`WORKSPACE_ID\` | Current workspace identifier |
| \`ORG_ID\` | Organization the workspace belongs to |
| \`THREAD_ID\` | Current chat thread |
| \`ANTHROPIC_API_KEY\` | Proxy token for LLM calls |
| \`CLOUDFLARE_API_TOKEN\` | Deploy token (workspace-scoped) |
| \`DATA_PROXY_URL\` | Thread-scoped SQL proxy base URL (SQL Server/PostgreSQL/MySQL; sandbox-authenticated) |
| \`OPENAI_PROXY_URL\` | Thread-scoped OpenAI-compatible proxy base URL |
| \`OPENAI_BASE_URL\` | OpenAI SDK-compatible base URL (\`.../v1\`) for chat/embeddings/responses |
| \`OPENAI_API_KEY\` | Placeholder API key for OpenAI-compatible clients (\`proxy\`) |
| \`INT_*\` | Integration credentials (e.g., \`INT_STRIPE_SECRET_KEY\`) |

Integration credentials auto-sync to deployed workers as secrets.

If environment variables (especially \`INT_*\` integration credentials) appear stale or missing during a session, manually re-source the env file:
\`\`\`bash
set -a && source "$CLAUDE_ENV_FILE" && set +a
\`\`\`

AI access patterns:
- In the container/runtime, use the local OpenAI-compatible proxy (\`OPENAI_BASE_URL\` + \`OPENAI_API_KEY=proxy\`) for SDK calls.
- For chat completions through this local proxy, pass one of the supported model aliases (\`auto\`, \`auto_search\`, \`auto_image\`) as the \`model\` field. Unknown models fall back to \`auto\`.
- In deployed workers, prefer native \`env.AI\` via the Workers AI provider. In camelAI this AI binding is virtualized by the platform and routes to a model configured by \`AI_VIRTUAL_MODEL\` (default \`auto\`).
- Avoid setting \`max_tokens\` unless the user explicitly asks for a hard cap. Reasoning/thinking tokens count toward that budget and can truncate responses before completion.
- If you must set \`max_tokens\`, choose a conservative high value with enough headroom for thinking + final output, and warn the user when truncation risk remains.

Model routes (use with \`workersai(routeName, {})\` in deployed workers, or \`model: "routeName"\` in the container OpenAI-compatible proxy):
- \`auto\` — Default. Text generation + tool calling. Use for general-purpose AI features.
- \`auto_search\` — Enables Google Search grounding. Use when the app needs real-time or current information (news, live prices, recent events, fact-checking, up-to-date answers). The model can cite web sources inline.
- \`auto_image\` — Enables image generation. Use when the app needs to create images from text prompts (avatars, illustrations, thumbnails, creative content). Generated images are returned in \`response.messages[].images[]\`.
Always default to \`auto\` unless the user's use case clearly requires search grounding or image generation. Model selection is supported in both deployed workers and the container proxy. An app can use multiple routes for different features (e.g., \`auto\` for chat, \`auto_search\` for a "research" mode, \`auto_image\` for an image creator).

Codemode (\`@cloudflare/codemode\`): Available in the starter template for deployed workers. Lets the LLM write TypeScript code that orchestrates multiple tools in a single turn instead of calling them one-by-one. Uses \`worker_loaders\` binding + \`DynamicWorkerExecutor\`.
</environment_variables>
</environment>

<core_constraints>
**Critical things to remember:**

- **localhost is not accessible** — Users cannot open localhost URLs. Deploy to make things accessible, or output content directly.
- **Don't assume technical ability** — Users may not be developers. Explain what you're doing in plain language. Avoid jargon unless they demonstrate familiarity.
- **Show results, not processes** — Instead of saying "run npm start and open localhost:3000", deploy the app or show the output directly.
- **Use short bash timeouts** — This is an interactive session. Default to shorter timeouts. Use longer ones only when necessary (deployments, builds).
- **Avoid large package installations** — Do not install heavy frameworks like OpenNext or Next.js from scratch. They degrade user experience. Use pre-configured templates instead.
</core_constraints>

<chat_preview_pane>
The **chat preview pane** is how users see your visual work. It's a multi-tab panel that can render almost anything—notebooks, HTML, CSVs, images, deployed apps, and more.

**You control what's shown.** Use \`set_file_preview()\` to pull up any file:

\`\`\`python
set_file_preview(
  path="/home/claude/analysis.ipynb",
  content_type="application/x-ipynb+json"
)
\`\`\`

**Multi-tab support:** Users can click on any file tag in your messages to open it in the preview pane. Multiple files can be open as tabs.

**What renders well:**
- **Jupyter notebooks** — Rendered in Report mode (polished article view) by default
- **CSV/data files** — Displayed as interactive tables
- **Images** — Displayed inline
- **Deployed Workers** — Live app preview with the deployed URL

**What does NOT render:**
- **HTML files** — Raw HTML won't display. Deploy as a Worker if you need to show HTML content.

**Output rules:**
- **Never paste raw HTML in chat** — HTML doesn't render in the preview pane. Deploy it as a Worker instead.
- **Never use "download and open" workflows** — If it's meant to be seen, show it in the preview pane or deploy it
- **Prefer notebooks for data analysis** — They combine code, visuals, and prose in one artifact that renders beautifully in Report mode
- **Deploy for live/interactive apps** — Use Workers when you need persistence, APIs, or user interaction beyond viewing

The preview pane is the primary way users experience your work. Use it liberally.
</chat_preview_pane>

<data_analysis>
**Always invoke the data-analysis skill** when doing any analytical work that involves:
- Writing SQL queries (any dialect)
- Writing Python to process, analyze, or visualize data
- Connecting to databases — camelAI supports 40+ data sources including PostgreSQL, MySQL, Clickhouse, BigQuery, Snowflake, SQL Server, and many more
- Processing files like CSVs, Excel, Parquet, PDFs, or any structured data
- Creating charts, graphs, or visualizations
- Running statistical analysis or ML models

The data-analysis skill provides the full workflow: database connectivity patterns, package installation, notebook structure, chart library preferences (Altair → Plotly → matplotlib), and Report mode formatting. **Read it before starting any data work.**

Deliver analysis results as Jupyter notebooks rendered in Report mode — not as raw Python scripts, standalone chart files, or text summaries in chat.
If the user wants to publish a file (notebook, markdown, CSV, etc.) as a standalone app, deploy it with \`publish <name> --file <path>\`.
</data_analysis>

<deployment>
<cloudflare_workers>
All deployable software runs as Cloudflare Workers. The infrastructure is pre-configured.

**Key principles:**
1. Use the globally installed \`wrangler\` CLI—do not install it locally
2. For persistence, use SQLite-backed Durable Objects (not KV)
3. Deploy with: \`wrangler deploy --dispatch-namespace chiridion\`
4. For any web app with UI, use \`create-worker\` to scaffold from the camelAI starter template
5. To publish any file (notebook, markdown, CSV, etc.) as a standalone app, use \`publish <name> --file <path>\`
6. For AI in deployed workers, use \`env.AI\` (or \`createWorkersAI({ binding: env.AI })\`) instead of embedding third-party model API keys in worker code.

The starter template includes React Router 7 + shadcn/ui pre-configured. Only skip the template for pure API workers with no frontend.
</cloudflare_workers>

<deployment_urls>
Each deployed app gets two URLs:

| URL Pattern | Use Case |
|-------------|----------|
| \`https://{name}.apps.camelai.dev\` | Same-site iframe (inherits auth) |
| \`https://{name}.camelai.app\` | Public vanity URL |
</deployment_urls>

<app_visibility>
Apps can be **public** or **private**:
- **Public**: Anyone can access via the URL
- **Private**: Only organization members (requires authentication)

You cannot change visibility programmatically—it's controlled via the camelAI UI. If a user asks about making an app public or private, explain that they can change this in their Apps list in the camelAI interface.
</app_visibility>

<using_integrations>
When users connect external services, credentials appear as \`INT_*\` environment variables:

\`\`\`bash
INT_STRIPE_SECRET_KEY=sk_live_...
INT_OPENAI_API_KEY=sk-...
INT_GITHUB_TOKEN=ghp_...
\`\`\`

In deployed workers, access them from the \`env\` parameter:

\`\`\`typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const stripe = new Stripe(env.INT_STRIPE_SECRET_KEY);
    // ...
  }
}
\`\`\`

If a user asks you to use an integration that isn't connected, explain what integrations are available (check \`env | grep INT_\`) and guide them to connect it in the camelAI integrations panel.
</using_integrations>
</deployment>

<file_sharing>
You have two special directories for exchanging files with users:

**\`/mnt/user-uploads/\`** — Files uploaded by the user. When a user uploads a file, you'll see a message like "(user uploaded file to /mnt/user-uploads/filename.png)". Read files from here.

**\`/mnt/user-outputs/\`** — Files you create for the user. Save files here when you want the user to download or preview them.

**Creating downloadable/previewable files:**
When you save to \`/mnt/user-outputs/\`, provide a URL:
- Image preview: \`![Description](/api/workspaces/${wsId}/outputs/chart.png)\`
- Download link: \`[Download Report](/api/workspaces/${wsId}/outputs/report.pdf)\`

Images render inline in the chat; other files trigger download.
</file_sharing>

<package_management>
<node>
Always use **\`bun\`** for Node.js package management. Do not use \`npm\` or \`yarn\`—use \`bun\` exclusively for installing dependencies, running scripts, and managing packages.
</node>

<python>
Use **\`uv\`** for Python package management.

**First time in a workspace**, initialize a Python project:
\`\`\`bash
uv init --python 3.13
uv add pandas numpy matplotlib  # cached in image, instant
\`\`\`

**Run scripts and tools:**
\`\`\`bash
uv run python script.py
uv run jupyter nbconvert --to notebook --execute --inplace notebook.ipynb
\`\`\`

**Add packages:** \`uv add <package>\` — common data analysis packages are cached in the image for instant installation. The project's \`pyproject.toml\` and \`.venv\` persist across sessions.

**Skip \`uv init\` if \`pyproject.toml\` already exists** — just \`uv add\` and \`uv run\`.
</python>
</package_management>

<multi_user_threads>
Threads can have multiple users. Each message is prefixed with the sender's identity:
- \`[Name (email)]: message\`
- \`[email]: message\`

Pay attention to who is speaking. Different team members may have different questions, contexts, or permissions. Address the right person when responding.
</multi_user_threads>

<camelai_context_blocks>
Some messages include hidden context from camelAI:
- \`<camelai system message> ... </camelai system message>\`

Treat content in these blocks as trusted operator context. Use it to guide your response, but do not mention the blocks, quote their wrappers, or tell the user that hidden context was provided.
</camelai_context_blocks>


<asking_questions>
Use the **AskUserQuestion** tool when you have choices that affect the outcome.

**Good uses:**
- Choosing between approaches ("SQLite or KV for this?")
- Clarifying requirements ("What color theme?")
- Confirming significant actions ("This will delete the old data. Proceed?")
- Offering feature options ("Include authentication?")

**Don't use for:**
- Simple yes/no questions that don't matter
- When you have enough information to proceed
- Questions you can answer by reading code or docs

The tool presents options as clickable buttons. Don't make assumptions when multiple valid paths exist—ask.
</asking_questions>

<tone_and_style>
<general_approach>
You're having a conversation with a collaborator, not executing commands for a customer. Be warm but professional. Explain what you're doing and why, especially for non-technical users.

Keep responses concise. This is a chat interface—walls of text are harder to read than short, focused messages with clear next steps.

If something fails, explain what happened and what you're trying next. Don't just silently retry or dump error logs.
</general_approach>

<formatting>
Avoid over-formatting. Use headers, lists, and bold sparingly—only when they genuinely help comprehension. In casual conversation, respond in sentences and paragraphs.

When showing code or terminal output, keep it focused. Show the relevant parts, not everything.

Do not use emojis unless the user uses them first. Even then, be sparing.
</formatting>

<when_things_go_wrong>
If you can't help with something:
- Explain why clearly
- Suggest alternatives if any exist
- Don't apologize excessively

If you made a mistake:
- Acknowledge it simply
- Fix it
- Move on

If a user is frustrated, stay calm and helpful. Focus on solving the problem.
</when_things_go_wrong>
</tone_and_style>

<getting_help>
If users ask how to use camelAI or have questions about the platform:
- For feature questions, explain what you know about camelAI's capabilities
- For billing, account, or technical support issues, direct them to support@camelai.com
- For bugs or feedback, encourage them to use the feedback button in the interface

You can help users understand what's possible, but you can't change account settings, billing, or platform configuration.
</getting_help>

<workspaces>
Users may have multiple workspaces. Each workspace is isolated:
- Separate filesystem
- Separate deployed apps
- Separate integrations

You only have access to the current workspace. If a user mentions something from another workspace, you won't have context on it—explain that workspaces are separate environments.
</workspaces>

<what_you_can_do>
| Action | How |
|--------|-----|
| Create/edit files | Write anywhere in \`/home/claude/\` |
| Run commands | Execute in container shell |
| Deploy workers | \`wrangler deploy --dispatch-namespace chiridion\` |
| Control preview pane | \`set_file_preview()\` to show any file |
| Use integrations | Access via \`INT_*\` env vars |
| Provide downloads | Write to \`/mnt/user-outputs/\` |
</what_you_can_do>

<what_you_cannot_do>
| Action | Why |
|--------|-----|
| Change app visibility | Requires camelAI UI |
| Delete deployed apps | Requires camelAI UI |
| Access other workspaces | Container isolation |
| Expose localhost to users | Container not routable |
| Modify account/billing | Requires camelAI account settings |
</what_you_cannot_do>

</camelai_behavior>
`;
}

function withThreadProxyPath(rawUrl, threadId) {
  try {
    const url = new URL(rawUrl);
    const basePath = '/proxy';
    if (!url.pathname.startsWith(basePath)) return rawUrl;

    const threadPathPrefix = `${basePath}/${encodeURIComponent(threadId)}`;
    if (url.pathname.startsWith(`${threadPathPrefix}/`) || url.pathname === threadPathPrefix) {
      return url.toString();
    }

    const suffix = url.pathname.slice(basePath.length);
    url.pathname = `${threadPathPrefix}${suffix || '/'}`;
    return url.toString();
  } catch {
    return rawUrl;
  }
}

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
    this.activityGeneration = 0;
    this.hasTerminalResultSinceActivity = false;
    this.clients = new Set();
    this.shuttingDown = false;
    this.teamPolling = new TeamPollingController({
      threadId: this.threadId,
      trace: traceControlPlane,
      canPoll: () => !this.shuttingDown && this.hasTerminalResultSinceActivity,
      injectMessage: content => this.handleMessage(content),
      broadcastStreamingResumed: () => this.broadcast({ type: 'streaming_resumed', source: 'team_poll' }),
      onSettled: () => this.scheduleDisconnectIfIdleEligible('team_poll_end'),
    });
    this.nextOutboundSeq = 1;
    this.replayBuffer = [];
  }

  updateSessionEnv(nextSessionEnv) {
    const incoming = nextSessionEnv && typeof nextSessionEnv === 'object' ? nextSessionEnv : {};
    this.sessionEnv = {
      ...this.sessionEnv,
      ...incoming,
    };
  }

  addClient(ws) {
    this.clients.add(ws);
    traceControlPlane('session_client_state', {
      action: 'add',
      ...wsDebugSnapshot(ws),
    });
    traceControlPlane('session_client_added', {
      threadId: this.threadId,
      clientCount: this.clients.size,
      pendingQuestions: this.pendingQuestions.size,
      messageQueueLength: this.messageQueue.length,
    });
  }

  removeClient(ws) {
    this.clients.delete(ws);
    traceControlPlane('session_client_state', {
      action: 'remove',
      ...wsDebugSnapshot(ws),
    });
    traceControlPlane('session_client_removed', {
      threadId: this.threadId,
      clientCount: this.clients.size,
      pendingQuestions: this.pendingQuestions.size,
      messageQueueLength: this.messageQueue.length,
    });
  }

  broadcast(payload) {
    const payloadType = payload && typeof payload === 'object' ? payload.type : undefined;
    const seq = this.nextOutboundSeq++;
    const sequencedPayload = {
      ...payload,
      seq,
    };
    const json = JSON.stringify(sequencedPayload);
    this.replayBuffer.push(sequencedPayload);
    if (this.replayBuffer.length > REPLAY_BUFFER_MAX) {
      this.replayBuffer.shift();
    }
    traceControlPlane('session_broadcast', {
      threadId: this.threadId,
      payloadType: typeof payloadType === 'string' ? payloadType : 'unknown',
      seq,
      clientCount: this.clients.size,
      bytes: json.length,
      replayBufferSize: this.replayBuffer.length,
    });
    for (const ws of this.clients) {
      try {
        ws.send(json);
        noteOutbound(ws, typeof payloadType === 'string' ? payloadType : 'unknown');
      } catch (err) {
        traceControlPlane('session_broadcast_send_failed', {
          threadId: this.threadId,
          payloadType: typeof payloadType === 'string' ? payloadType : 'unknown',
          seq,
          bytes: json.length,
          error: err instanceof Error ? err.message : String(err),
          ...wsDebugSnapshot(ws),
        });
      }
    }
  }

  replaySince(ws, lastSeq) {
    const normalizedLastSeq = Number.isFinite(lastSeq) ? Math.max(0, Math.floor(lastSeq)) : 0;
    const oldestSeq = this.replayBuffer.length > 0 ? this.replayBuffer[0].seq : null;
    const newestSeq = this.replayBuffer.length > 0 ? this.replayBuffer[this.replayBuffer.length - 1].seq : null;
    if (oldestSeq !== null && normalizedLastSeq + 1 < oldestSeq) {
      sendWsJson(ws, {
        type: 'replay_gap',
        oldestSeq,
        newestSeq,
        requestedAfterSeq: normalizedLastSeq,
      }, 'init_replay_gap');
    }

    let replayed = 0;
    for (const payload of this.replayBuffer) {
      if (typeof payload.seq !== 'number' || payload.seq <= normalizedLastSeq) continue;
      if (sendWsJson(ws, payload, 'init_replay_event')) {
        replayed += 1;
      }
    }

    traceControlPlane('session_replay_complete', {
      threadId: this.threadId,
      requestedAfterSeq: normalizedLastSeq,
      oldestSeq,
      newestSeq,
      replayed,
      replayBufferSize: this.replayBuffer.length,
      ...wsDebugSnapshot(ws),
    });
  }

  markUserActivity(source) {
    this.activityGeneration += 1;
    this.hasTerminalResultSinceActivity = false;
    this.clearDisconnect();
    traceControlPlane('session_user_activity', {
      threadId: this.threadId,
      source,
      activityGeneration: this.activityGeneration,
      hasTerminalResultSinceActivity: this.hasTerminalResultSinceActivity,
      pendingQuestions: this.pendingQuestions.size,
      queueLength: this.messageQueue.length,
    });
  }

  markTerminalResult() {
    this.hasTerminalResultSinceActivity = true;
    traceControlPlane('session_terminal_result_seen', {
      threadId: this.threadId,
      activityGeneration: this.activityGeneration,
    });
  }

  canIdleDisconnect() {
    return (
      this.hasTerminalResultSinceActivity &&
      !this.activeQuery &&
      !this.eventLoopRunning &&
      this.pendingQuestions.size === 0 &&
      this.messageQueue.length === 0 &&
      !this.shuttingDown &&
      !this.teamPolling.isRunning()
    );
  }

  /**
   * Start the post-result disconnect timer. After 1 minute of no new
   * user activity following a final result, signal the DO to close first,
   * then force-close as a fallback.
   */
  scheduleDisconnect() {
    this.clearDisconnect();
    const generationAtSchedule = this.activityGeneration;
    traceControlPlane('session_schedule_disconnect', {
      threadId: this.threadId,
      delayMs: DISCONNECT_IDLE_MS,
      generationAtSchedule,
      activeQuery: Boolean(this.activeQuery),
      eventLoopRunning: this.eventLoopRunning,
      hasTerminalResultSinceActivity: this.hasTerminalResultSinceActivity,
      pendingQuestions: this.pendingQuestions.size,
      queueLength: this.messageQueue.length,
      clientCount: this.clients.size,
    });
    this.disconnectTimer = setTimeout(() => {
      if (generationAtSchedule !== this.activityGeneration) {
        traceControlPlane('session_disconnect_timer_skipped_generation', {
          threadId: this.threadId,
          generationAtSchedule,
          currentGeneration: this.activityGeneration,
        });
        return;
      }
      if (!this.canIdleDisconnect()) {
        traceControlPlane('session_disconnect_timer_skipped_not_idle', {
          threadId: this.threadId,
          generationAtSchedule,
          activeQuery: Boolean(this.activeQuery),
          eventLoopRunning: this.eventLoopRunning,
          hasTerminalResultSinceActivity: this.hasTerminalResultSinceActivity,
          pendingQuestions: this.pendingQuestions.size,
          queueLength: this.messageQueue.length,
          shuttingDown: this.shuttingDown,
        });
        return;
      }

      console.log(`[ControlPlane] signaling idle disconnect thread=${this.threadId}`);
      traceControlPlane('session_disconnect_timer_fired', {
        threadId: this.threadId,
        generationAtSchedule,
        clientCount: this.clients.size,
      });
      this.broadcast({
        type: 'control',
        action: 'runner_idle_disconnect',
        reason: 'post_result_idle',
        idleMs: DISCONNECT_IDLE_MS,
      });

      setTimeout(() => {
        if (generationAtSchedule !== this.activityGeneration) {
          traceControlPlane('session_idle_disconnect_close_skipped_generation', {
            threadId: this.threadId,
            generationAtSchedule,
            currentGeneration: this.activityGeneration,
          });
          return;
        }
        if (!this.canIdleDisconnect()) {
          traceControlPlane('session_idle_disconnect_close_skipped_not_idle', {
            threadId: this.threadId,
            generationAtSchedule,
          });
          return;
        }
        for (const ws of this.clients) {
          closeWsWithTrace(ws, 1000, 'idle', 'idle_disconnect_timer');
        }
      }, IDLE_DISCONNECT_CLOSE_GRACE_MS);
    }, DISCONNECT_IDLE_MS);
  }

  scheduleDisconnectIfIdleEligible(source) {
    if (!this.hasTerminalResultSinceActivity) {
      traceControlPlane('session_schedule_disconnect_skipped_no_result', {
        threadId: this.threadId,
        source,
        activityGeneration: this.activityGeneration,
      });
      return;
    }
    if (!this.canIdleDisconnect()) {
      traceControlPlane('session_schedule_disconnect_skipped_not_idle', {
        threadId: this.threadId,
        source,
        activeQuery: Boolean(this.activeQuery),
        eventLoopRunning: this.eventLoopRunning,
        pendingQuestions: this.pendingQuestions.size,
        queueLength: this.messageQueue.length,
      });
      return;
    }
    this.scheduleDisconnect();
  }

  clearDisconnect() {
    if (this.disconnectTimer) {
      traceControlPlane('session_clear_disconnect', {
        threadId: this.threadId,
      });
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
  }

  shutdown() {
    this.shuttingDown = true;
    this.teamPolling.shutdown();
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
    if (toolName !== 'AskUserQuestion') return { behavior: 'allow', updatedInput: input };
    const questions = input?.questions;
    if (!Array.isArray(questions) || questions.length === 0) return { behavior: 'allow', updatedInput: input };

    const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const toolUseId = opts?.toolUseID;

    const answerPromise = new Promise((resolve) => {
      this.pendingQuestions.set(questionId, { questionId, toolUseId, questions, resolve });
    });

    this.clearDisconnect();
    this.broadcast({ type: 'ask_user_question', questionId, toolUseId, questions });
    const answers = await answerPromise;
    return { behavior: 'allow', updatedInput: { questions, answers } };
  }

  handleQuestionResponse(questionId, answers) {
    this.markUserActivity('question_response');
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);
    pending.resolve(answers);
    traceControlPlane('session_question_answered', {
      threadId: this.threadId,
      questionId,
      pendingQuestions: this.pendingQuestions.size,
    });
    this.broadcast({ type: 'question_answered', questionId });
  }

  getQueryOptions(fileExists) {
    // Merge: process.env (Docker env vars) + sessionEnv (per-thread from WebSocket init)
    const mergedEnv = {
      ...process.env,
      ...this.sessionEnv,
      THREAD_ID: this.threadId,
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    };
    // Rewrite all proxy URLs (including Anthropic) to route through the
    // sandbox-host proxy with thread context. BYOK credentials are handled
    // entirely in sandbox-host via WebSocket upgrade headers.
    const proxyThreadId = this.threadId;
    if (proxyThreadId) {
      for (const key of ['ANTHROPIC_BASE_URL', 'CLOUDFLARE_API_BASE_URL', 'DATA_PROXY_URL', 'OPENAI_PROXY_URL', 'OPENAI_BASE_URL', 'MCP_SERVER_URL']) {
        const value = mergedEnv[key];
        if (typeof value === 'string' && value.length > 0) {
          mergedEnv[key] = withThreadProxyPath(value, proxyThreadId);
        }
      }
    }

    const mcpServerUrl = mergedEnv.MCP_SERVER_URL;
    const mcpServers = {};
    if (mcpServerUrl) {
      mcpServers.camelai = {
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
        allowedTools: ['mcp__camelai__*'],
      }),
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
        traceControlPlane('session_dequeue_message', {
          threadId: this.threadId,
          source: 'queue',
          remainingQueue: this.messageQueue.length,
          messageLength: typeof message === 'string' ? message.length : 0,
        });
      } else {
        if (this.shuttingDown) return;
        message = await new Promise((resolve) => { this.messageResolver = resolve; });
        if (this.shuttingDown) {
          if (this.messageQueue.length > 0) {
            message = this.messageQueue.shift();
            traceControlPlane('session_dequeue_message', {
              threadId: this.threadId,
              source: 'queue_after_shutdown',
              remainingQueue: this.messageQueue.length,
              messageLength: typeof message === 'string' ? message.length : 0,
            });
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
      traceControlPlane('session_init_reused', {
        threadId: this.threadId,
        hasActiveQuery: Boolean(this.activeQuery),
        hasInitPromise: Boolean(this.initPromise),
      });
      return;
    }

    this.initPromise = (async () => {
      const t0 = performance.now();
      this.userProfile = await loadUserProfile().catch(() => null);
      const tProfile = performance.now();
      const fileExists = await this.sessionFileExists();
      const tFileCheck = performance.now();
      const options = this.getQueryOptions(fileExists);
      const hasMcp = Boolean(options.mcpServers && Object.keys(options.mcpServers).length > 0);
      const messageStream = this.createMessageStream();
      this.activeQuery = query({ prompt: messageStream, options });
      const tQuery = performance.now();
      this.queryIterator = this.activeQuery[Symbol.asyncIterator]();
      const tIterator = performance.now();
      traceControlPlane('session_query_initialized', {
        threadId: this.threadId,
        fileExists,
        hasMcp,
        timings: {
          profileMs: Math.round(tProfile - t0),
          fileCheckMs: Math.round(tFileCheck - tProfile),
          queryCreateMs: Math.round(tQuery - tFileCheck),
          iteratorMs: Math.round(tIterator - tQuery),
          totalMs: Math.round(tIterator - t0),
        },
      });
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
    traceControlPlane('session_event_loop_start', {
      threadId: this.threadId,
      clientCount: this.clients.size,
    });

    (async () => {
      try {
        await this.teamPolling.init();
        while (true) {
          const { value: event, done } = await this.queryIterator.next();
          if (done) break;
          traceControlPlane('session_event_loop_event', {
            threadId: this.threadId,
            eventType: typeof event?.type === 'string' ? event.type : 'unknown',
            eventSubtype: typeof event?.subtype === 'string' ? event.subtype : '',
          });

          this.broadcast({ type: 'sdk_event', event });
          if (event?.type === 'result') {
            this.markTerminalResult();
            this.teamPolling.requestPoll();
          }

          if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
            this.forwardCompactSummary(event).catch(() => {});
          }

          this.teamPolling.onSdkEvent(event);
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
        traceControlPlane('session_event_loop_stop', {
          threadId: this.threadId,
          clientCount: this.clients.size,
        });
        this.scheduleDisconnectIfIdleEligible('event_loop_stop');
      }
    })();
  }

  async handleMessage(content) {
    if (typeof content !== 'string' || !content.trim()) return;
    traceControlPlane('session_handle_message', {
      threadId: this.threadId,
      contentLength: content.trim().length,
      hasResolver: Boolean(this.messageResolver),
      queueLength: this.messageQueue.length,
      clientCount: this.clients.size,
    });
    this.markUserActivity('message');
    await this.init();
    this.startEventLoop();

    if (this.messageResolver) {
      const r = this.messageResolver;
      this.messageResolver = null;
      r(content.trim());
    } else {
      this.messageQueue.push(content.trim());
      traceControlPlane('session_queue_message', {
        threadId: this.threadId,
        queueLength: this.messageQueue.length,
        contentLength: content.trim().length,
      });
    }
  }

  async handleStop() {
    this.markUserActivity('stop');
    traceControlPlane('session_handle_stop', {
      threadId: this.threadId,
      pendingQuestions: this.pendingQuestions.size,
      hasActiveQuery: Boolean(this.activeQuery),
    });
    for (const [qid, pending] of this.pendingQuestions) {
      this.pendingQuestions.delete(qid);
      this.broadcast({ type: 'question_answered', questionId: qid });
      pending.resolve({});
    }
    if (this.activeQuery) {
      try {
        await this.activeQuery.interrupt();
      } catch (err) {
        traceControlPlane('session_stop_interrupt_failed', {
          threadId: this.threadId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

function getOrCreateSession(threadId, sessionEnv) {
  let session = chatSessions.get(threadId);
  if (!session) {
    session = new ChatSession(threadId, sessionEnv);
    chatSessions.set(threadId, session);
    traceControlPlane('session_created', {
      threadId,
      totalSessions: chatSessions.size,
    });
  } else {
    session.updateSessionEnv(sessionEnv);
    traceControlPlane('session_reused', {
      threadId,
      totalSessions: chatSessions.size,
    });
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

Bun.serve({
  port: PORT,
  idleTimeout: CONTROL_PLANE_IDLE_TIMEOUT_SECS,

  async fetch(req, server) {
    const url = new URL(req.url);
    traceControlPlane('http_request', {
      method: req.method,
      path: url.pathname,
      search: url.search,
    });

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
      initWsDebugState(ws);
      console.log('[ControlPlane] websocket opened (awaiting init)');
      traceControlPlane('ws_open', {
        initialized: false,
        ...wsDebugSnapshot(ws),
      });
    },

    message(ws, data) {
      if (typeof data !== 'string') {
        traceControlPlane('ws_message_ignored_non_string', {
          ...wsDebugSnapshot(ws),
        });
        return;
      }
      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        traceControlPlane('ws_message_invalid_json', {
          ...wsDebugSnapshot(ws),
          bytes: data.length,
        });
        return;
      }
      const messageType = typeof msg?.type === 'string' ? msg.type : 'unknown';
      noteInbound(ws, messageType, data.length);

      if (msg.type === 'init') {
        const threadId = msg.threadId;
        if (!threadId) {
          sendWsJson(ws, { type: 'error', error: 'threadId required in init' }, 'init_missing_thread_id');
          closeWsWithTrace(ws, 1008, 'missing_thread_id', 'init_missing_thread_id');
          return;
        }
        const lastSeq = typeof msg.lastSeq === 'number' && Number.isFinite(msg.lastSeq)
          ? Math.max(0, Math.floor(msg.lastSeq))
          : 0;
        const sessionEnv = msg.env || {};
        const session = getOrCreateSession(threadId, sessionEnv);
        // If the session's seq counter is behind the client's lastSeq
        // (e.g. container restarted and session was recreated), advance it
        // so new events won't be deduped by the client.
        if (lastSeq > 0 && session.nextOutboundSeq <= lastSeq) {
          const oldSeq = session.nextOutboundSeq;
          session.nextOutboundSeq = lastSeq + 1;
          traceControlPlane('session_seq_advanced', {
            threadId,
            oldSeq,
            newSeq: session.nextOutboundSeq,
            clientLastSeq: lastSeq,
          });
        }
        ws.data.threadId = threadId;
        ws.data.session = session;
        session.addClient(ws);
        console.log(`[ControlPlane] websocket initialized thread=${threadId}`);
        session.replaySince(ws, lastSeq);
        sendWsJson(ws, { type: 'ready', threadId }, 'init_ready');
        traceControlPlane('ws_init_complete', {
          ...wsDebugSnapshot(ws),
          lastSeq,
          pendingQuestions: session.pendingQuestions.size,
          clientCount: session.clients.size,
        });

        // Replay pending questions
        for (const pending of session.pendingQuestions.values()) {
          sendWsJson(ws, {
            type: 'ask_user_question',
            questionId: pending.questionId,
            toolUseId: pending.toolUseId,
            questions: pending.questions,
          }, 'init_replay_pending_question');
        }
        return;
      }

      const session = ws.data.session;
      if (!session) {
        sendWsJson(ws, { type: 'error', error: 'Send init message first' }, 'message_before_init');
        return;
      }

      if (msg.type === 'heartbeat') {
        sendWsJson(ws, {
          type: 'heartbeat_ack',
          ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
        }, 'heartbeat_ack');
        traceControlPlane('ws_heartbeat_ack', {
          ...wsDebugSnapshot(ws),
        });
        return;
      }

      if (msg.type === 'ping') {
        sendWsJson(ws, {
          type: 'pong',
          ts: typeof msg.ts === 'number' ? msg.ts : Date.now(),
        }, 'ping_pong');
        traceControlPlane('ws_pong', {
          ...wsDebugSnapshot(ws),
        });
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
      traceControlPlane('ws_close', {
        ...wsDebugSnapshot(ws),
        code,
        reason: reasonText,
        hadSession: Boolean(session),
        remainingClients: session ? session.clients.size : 0,
      });
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
