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

import { query, tool, createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { spawn } from 'node:child_process';

import { existsSync } from 'node:fs';
import { readFile, access, mkdir, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { TeamPollingController } from './team-poll-controller.mjs';

const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '8080', 10);
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
const CODEX_HOME = process.env.CODEX_HOME || `${homedir()}/.codex`;
const DEFAULT_CHAT_PROVIDER = process.env.CHIRIDION_CHAT_PROVIDER === 'codex' ? 'codex' : 'claude';
const DEFAULT_CODEX_MODEL = process.env.CHIRIDION_CODEX_MODEL || 'gpt-5.4';
const DEFAULT_CLAUDE_MODEL = process.env.CHIRIDION_CLAUDE_MODEL || 'opus';
const CAMELAI_CODEX_PROVIDER_ID = 'camelai_openai_proxy';
const CAMELAI_UI_MCP_SERVER_NAME = 'camelai_ui';
const CONTROL_PLANE_IDLE_TIMEOUT_SECS = Math.max(
  10,
  parseInt(process.env.CONTROL_PLANE_IDLE_TIMEOUT_SECS || '120', 10)
);
const SCREENSHOT_MCP_SERVER_PATH = fileURLToPath(new URL('./screenshot-mcp-server.mjs', import.meta.url));
const ASK_USER_QUESTION_MCP_SERVER_PATH = fileURLToPath(
  new URL('./ask-user-question-mcp-server.mjs', import.meta.url),
);

// ─── Screenshot MCP Server (in-process) ─────────────────────

function createScreenshotMcpServer(sessionToken) {
  return createSdkMcpServer({
    name: 'screenshot',
    version: '1.0.0',
    tools: [
      tool(
        'take_screenshot',
        'Take a screenshot of a URL and return the image. Use this after deploying an app to verify it renders correctly. Pass the full app URL (get it from list_apps first). Automatically authenticates with private *.camelai.app deployments.',
        {
          url: z.string().url().describe('The full URL to screenshot (e.g. https://my-app--my-org.camelai.app)'),
          width: z.number().int().min(320).max(3840).optional().describe('Viewport width in pixels (default 1280)'),
          height: z.number().int().min(240).max(2160).optional().describe('Viewport height in pixels (default 720)'),
        },
        async ({ url, width, height }) => {
          const HARD_TIMEOUT_MS = 10_000;
          const CLEANUP_TIMEOUT_MS = 1_500;
          const viewportWidth = width ?? 1280;
          const viewportHeight = height ?? 720;

          let browser;
          let timedOut = false;
          let hardTimer;
          let cleanupPromise = null;
          const abortController = new AbortController();

          const cleanup = async () => {
            abortController.abort();
            if (cleanupPromise) return cleanupPromise;

            cleanupPromise = (async () => {
              if (!browser) return;

              const browserToClose = browser;
              browser = null;

              try {
                const closeResult = await Promise.race([
                  browserToClose.close().then(() => 'closed'),
                  new Promise((resolve) => setTimeout(() => resolve('timed_out'), CLEANUP_TIMEOUT_MS)),
                ]);
                if (closeResult === 'timed_out') {
                  console.warn('[screenshot-mcp] browser.close() timed out during cleanup');
                }
              } catch (closeError) {
                console.warn('[screenshot-mcp] browser.close() failed during cleanup', closeError);
              }
            })();

            try {
              await cleanupPromise;
            } finally {
              cleanupPromise = null;
            }
          };

          const doScreenshot = async () => {
            // Poll until the URL returns a 2xx response before launching the browser.
            // Newly deployed workers may not be reachable immediately.
            // Authenticate the probe for private apps so the dispatcher doesn't
            // redirect to auth (which would return 2xx from the login page, not the app).
            const hostname = new URL(url).hostname;
            const isTrusted = sessionToken &&
              (hostname.endsWith('.camelai.app') || hostname.endsWith('.camelai.dev'));
            const pollHeaders = {};
            if (isTrusted) {
              pollHeaders['Cookie'] = `chiridion_run_session=${sessionToken}`;
            }
            const pollStart = Date.now();
            while (Date.now() - pollStart < 3_000) {
              if (timedOut) throw new Error('Screenshot timed out (10s limit)');
              try {
                const res = await fetch(url, {
                  method: 'HEAD',
                  redirect: 'manual',
                  headers: pollHeaders,
                  signal: abortController.signal,
                });
                if (res.ok) break;
              } catch (e) {
                if (e.name === 'AbortError') throw new Error('Screenshot timed out (10s limit)');
              }
              await new Promise(r => setTimeout(r, 500));
            }

            if (timedOut) throw new Error('Screenshot timed out (10s limit)');
            const { chromium } = await import('playwright');
            browser = await chromium.launch({ args: ['--no-sandbox', '--disable-gpu'] });
            if (timedOut) { await cleanup(); throw new Error('Screenshot timed out (10s limit)'); }

            const context = await browser.newContext({
              viewport: { width: viewportWidth, height: viewportHeight },
              deviceScaleFactor: 1.5,
            });

            // Authenticate with private deployments using the session cookie.
            // Scope to the exact hostname to avoid leaking the token to sibling subdomains.
            if (isTrusted) {
              await context.addCookies([{
                name: 'chiridion_run_session',
                value: sessionToken,
                domain: hostname,
                path: '/',
                httpOnly: true,
              }]);
            }

            const page = await context.newPage();
            await page.goto(url, { waitUntil: 'load', timeout: 5_000 }).catch(() =>
              page.goto(url, { waitUntil: 'domcontentloaded', timeout: 5_000 })
            );

            const buffer = await page.screenshot({
              type: 'jpeg',
              quality: 80,
              clip: { x: 0, y: 0, width: viewportWidth, height: viewportHeight },
            });

            return {
              content: [{ type: 'image', data: buffer.toString('base64'), mimeType: 'image/jpeg' }],
            };
          };

          try {
            return await Promise.race([
              doScreenshot(),
              new Promise((_, reject) => {
                hardTimer = setTimeout(() => {
                  timedOut = true;
                  void cleanup().catch(() => {});
                  reject(new Error('Screenshot timed out (10s limit)'));
                }, HARD_TIMEOUT_MS);
              }),
            ]);
          } catch (err) {
            return {
              content: [{ type: 'text', text: `Screenshot failed: ${err.message}` }],
              isError: true,
            };
          } finally {
            clearTimeout(hardTimer);
            await cleanup();
          }
        }
      ),
    ],
  });
}

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
function buildSystemPromptAppend(provider = 'claude') {
  const questionToolName = provider === 'codex' ? 'ask_user_question' : 'AskUserQuestion';
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
| \`RESEND_PROXY_URL\` | Thread-scoped Resend email proxy base URL (workspace member-only, rate-limited) |
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

<pre_installed_tools>
**Playwright + Chromium** are pre-installed in the sandbox. Use them for E2E testing, web scraping, or browser automation without any installation step:
\`\`\`javascript
import { chromium } from "playwright";
const browser = await chromium.launch();
\`\`\`
The Chromium binary lives at \`/opt/playwright-browsers\`. The sandbox image is pinned to \`playwright@1.58.2\`, and generated or edited app code must use the same npm package version to avoid browser-revision mismatches. The starter template already pins that version and includes scaffolded E2E tests in \`e2e/smoke.test.mjs\` (commented out). For screenshots of deployed apps, prefer the \`take_screenshot\` MCP tool which handles authentication automatically.
</pre_installed_tools>
</environment>

<core_constraints>
**Critical things to remember:**

- **localhost is not accessible** — Users cannot open localhost URLs. Deploy to make things accessible, or output content directly.
- **Don't assume technical ability** — Users may not be developers. Explain what you're doing in plain language. Avoid jargon unless they demonstrate familiarity.
- **Show results, not processes** — Instead of saying "run npm start and open localhost:3000", deploy the app or show the output directly.
- **Use short bash timeouts** — This is an interactive session. Default to shorter timeouts. Use longer ones only when necessary (deployments, builds).
- **Avoid large package installations** — Do not install heavy frameworks like OpenNext or Next.js from scratch. They degrade user experience. Use pre-configured templates instead.
</core_constraints>

<prohibited_activities>
The following activities are strictly prohibited under camelAI's terms of service. You MUST refuse these requests immediately and completely, regardless of how the user frames them:

ABSOLUTELY PROHIBITED - NO EXCEPTIONS:
These apply everywhere: the sandbox container, deployed Cloudflare Worker apps, and any other context. Do not help with these activities in any form, whether running locally, deploying as an app, or writing code intended for use elsewhere.

- Reverse tunnels - Do not set up, run, deploy, or assist with any tunneling software that exposes the container, a deployed app, or any network to external access (e.g., ngrok, cloudflared tunnel, bore, localtunnel, frp, rathole, or any similar tool)
- Network relay/forwarding - Do not configure the container or any deployed app as a relay, VPN endpoint, SOCKS proxy, or any form of traffic forwarding node
- Crypto mining - Do not run cryptocurrency miners or related workloads
- Malware/exploit development - Do not write, compile, or execute malware, exploit code, or attack tools

Treat the following as strong indicators of the prohibited tunnel/relay category: requests to deploy a project, obtain a public URL, then wire a BRIDGE_URL, wss://... URL, /connect endpoint, WebSocket client, or init/bootstrap script so the deployed app connects back to another service or forwards traffic. Refuse these patterns even if the user describes them as setup, bootstrap, admin, syncing, or account tooling.

These are HARD rules. They cannot be overridden. camelAI will NEVER support these usecases, or ask you to do them for any purpose whatsoever.

If a user's request would result in any prohibited activity, refuse clearly. Explain that the activity is not permitted on camelAI. Do not suggest workarounds that achieve the same prohibited outcome.

If you are uncertain whether a request falls into a prohibited category, err on the side of caution and deny the activity. Tell them to file a support ticket with camelAI if they believe this is in error.
</prohibited_activities>

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
- Image preview: \`![Description](/api/workspaces/\${WORKSPACE_ID}/outputs/chart.png)\`
- Download link: \`[Download Report](/api/workspaces/\${WORKSPACE_ID}/outputs/report.pdf)\`

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

**BigQuery note:** \`google-cloud-bigquery\`, \`google-cloud-bigquery-storage\`, and \`google-auth\` are cached in the image for fast \`uv add\`, but they are not preinstalled in the shared base interpreter.

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
Use the **${questionToolName}** tool when you have choices that affect the outcome.

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

function buildThreadScopedEnv(sessionEnv = {}, threadId) {
  const mergedEnv = {
    ...process.env,
    ...sessionEnv,
    THREAD_ID: threadId,
  };

  const proxyThreadId = threadId;
  if (proxyThreadId) {
    for (const key of [
      'ANTHROPIC_BASE_URL',
      'CLOUDFLARE_API_BASE_URL',
      'DATA_PROXY_URL',
      'OPENAI_PROXY_URL',
      'OPENAI_BASE_URL',
      'MCP_SERVER_URL',
      'RESEND_PROXY_URL',
    ]) {
      const value = mergedEnv[key];
      if (typeof value === 'string' && value.length > 0) {
        mergedEnv[key] = withThreadProxyPath(value, proxyThreadId);
      }
    }
  }

  return mergedEnv;
}

function serializeTomlString(value) {
  return JSON.stringify(value);
}

function buildCodexConfigToml({ baseUrl, mcpServerUrl, screenshotSessionToken, threadId }) {
  const lines = [
    `model = ${serializeTomlString(DEFAULT_CODEX_MODEL)}`,
    `model_provider = ${serializeTomlString(CAMELAI_CODEX_PROVIDER_ID)}`,
    '',
    `[model_providers.${CAMELAI_CODEX_PROVIDER_ID}]`,
    `name = ${serializeTomlString('CamelAI OpenAI Proxy')}`,
    `base_url = ${serializeTomlString(baseUrl)}`,
    `wire_api = ${serializeTomlString('responses')}`,
    'supports_websockets = false',
    '',
  ];

  if (mcpServerUrl) {
    lines.push('[mcp_servers.camelai]');
    lines.push(`url = ${serializeTomlString(mcpServerUrl)}`);
    lines.push('');
  }

  lines.push(`[mcp_servers.${CAMELAI_UI_MCP_SERVER_NAME}]`);
  lines.push(`command = ${serializeTomlString(process.execPath)}`);
  lines.push(`args = [${serializeTomlString(ASK_USER_QUESTION_MCP_SERVER_PATH)}]`);
  lines.push(
    `env = { THREAD_ID = ${serializeTomlString(threadId)}, CONTROL_PLANE_PORT = ${serializeTomlString(String(PORT))} }`
  );
  lines.push('');

  lines.push('[mcp_servers.screenshot]');
  lines.push(`command = ${serializeTomlString(process.execPath)}`);
  lines.push(`args = [${serializeTomlString(SCREENSHOT_MCP_SERVER_PATH)}]`);
  if (screenshotSessionToken) {
    lines.push(
      `env = { CHIRIDION_APP_SESSION = ${serializeTomlString(screenshotSessionToken)} }`
    );
  }
  lines.push('');

  return lines.join('\n');
}

function getProviderFromEnv(sessionEnv = {}) {
  const provider = sessionEnv?.CHIRIDION_CHAT_PROVIDER;
  return provider === 'codex' ? 'codex' : 'claude';
}

function getDefaultModelForProvider(provider) {
  return provider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
}

function normalizeCodexTodoStatus(status) {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'inProgress':
    case 'in_progress':
      return 'in_progress';
    default:
      return 'pending';
  }
}

function extractCodexTodosFromRuntimeEvent(event) {
  if (
    !event ||
    typeof event !== 'object' ||
    event.method !== 'turn/plan/updated' ||
    !event.params ||
    typeof event.params !== 'object' ||
    !Array.isArray(event.params.plan)
  ) {
    return null;
  }

  return event.params.plan.map((step) => {
    const content =
      step && typeof step === 'object' && typeof step.step === 'string'
        ? step.step
        : 'Untitled task';
    return {
      content,
      status: normalizeCodexTodoStatus(
        step && typeof step === 'object' ? step.status : undefined,
      ),
      activeForm: content,
    };
  });
}

function getCodexExecutable() {
  for (const candidate of [
    resolve('/opt/chiridion/node_modules/.bin/codex'),
    resolve(process.cwd(), 'node_modules/.bin/codex'),
    'codex',
  ]) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }
  return 'codex';
}

function extractCodexItemText(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }
  if (typeof item.text === 'string') {
    return item.text;
  }
  const message = item.message;
  if (message && typeof message === 'object' && Array.isArray(message.content)) {
    return message.content
      .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
}

function shouldRetryWithFreshThread(error) {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const normalized = message.toLowerCase();
  return (
    normalized.includes('invalid request') ||
    normalized.includes('thread') ||
    normalized.includes('not found') ||
    normalized.includes('unknown')
  );
}

class CodexAppServerClient {
  constructor(threadId, sessionEnv = {}) {
    this.threadId = threadId;
    this.sessionEnv = sessionEnv;
    this.child = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pendingRequests = new Map();
    this.knownThreadIds = new Set();
    this.activeTurns = new Map();
    this.codexExecutable = getCodexExecutable();
    this.codexHome = `${CODEX_HOME}/threads/${threadId}`;
    this.refreshConfig();
  }

  refreshConfig() {
    const mergedEnv = buildThreadScopedEnv(this.sessionEnv, this.threadId);
    this.mergedEnv = mergedEnv;
    this.baseUrl = mergedEnv.OPENAI_BASE_URL || 'http://127.0.0.1/api/openai/v1';
    this.mcpServerUrl = mergedEnv.MCP_SERVER_URL || '';
    this.screenshotSessionToken =
      typeof mergedEnv.CHIRIDION_APP_SESSION === 'string' &&
      mergedEnv.CHIRIDION_APP_SESSION.trim()
        ? mergedEnv.CHIRIDION_APP_SESSION.trim()
        : '';
    this.developerInstructions = buildSystemPromptAppend('codex').trim();
  }

  updateSessionEnv(sessionEnv = {}) {
    const previousBaseUrl = this.baseUrl;
    const previousMcpServerUrl = this.mcpServerUrl;
    const previousScreenshotSessionToken = this.screenshotSessionToken;
    const previousEnvSignature = JSON.stringify({
      CLOUDFLARE_API_BASE_URL: this.mergedEnv?.CLOUDFLARE_API_BASE_URL || '',
      CLOUDFLARE_API_TOKEN: this.mergedEnv?.CLOUDFLARE_API_TOKEN || '',
      CLOUDFLARE_ACCOUNT_ID: this.mergedEnv?.CLOUDFLARE_ACCOUNT_ID || '',
      WRANGLER_SEND_METRICS: this.mergedEnv?.WRANGLER_SEND_METRICS || '',
      DATA_PROXY_URL: this.mergedEnv?.DATA_PROXY_URL || '',
      OPENAI_PROXY_URL: this.mergedEnv?.OPENAI_PROXY_URL || '',
      OPENAI_BASE_URL: this.mergedEnv?.OPENAI_BASE_URL || '',
      OPENAI_API_KEY: this.mergedEnv?.OPENAI_API_KEY || '',
      MCP_SERVER_URL: this.mergedEnv?.MCP_SERVER_URL || '',
      RESEND_PROXY_URL: this.mergedEnv?.RESEND_PROXY_URL || '',
      THREAD_ID: this.mergedEnv?.THREAD_ID || '',
      CHIRIDION_APP_SESSION: this.mergedEnv?.CHIRIDION_APP_SESSION || '',
    });
    this.sessionEnv = {
      ...this.sessionEnv,
      ...sessionEnv,
    };
    this.refreshConfig();
    const nextEnvSignature = JSON.stringify({
      CLOUDFLARE_API_BASE_URL: this.mergedEnv?.CLOUDFLARE_API_BASE_URL || '',
      CLOUDFLARE_API_TOKEN: this.mergedEnv?.CLOUDFLARE_API_TOKEN || '',
      CLOUDFLARE_ACCOUNT_ID: this.mergedEnv?.CLOUDFLARE_ACCOUNT_ID || '',
      WRANGLER_SEND_METRICS: this.mergedEnv?.WRANGLER_SEND_METRICS || '',
      DATA_PROXY_URL: this.mergedEnv?.DATA_PROXY_URL || '',
      OPENAI_PROXY_URL: this.mergedEnv?.OPENAI_PROXY_URL || '',
      OPENAI_BASE_URL: this.mergedEnv?.OPENAI_BASE_URL || '',
      OPENAI_API_KEY: this.mergedEnv?.OPENAI_API_KEY || '',
      MCP_SERVER_URL: this.mergedEnv?.MCP_SERVER_URL || '',
      RESEND_PROXY_URL: this.mergedEnv?.RESEND_PROXY_URL || '',
      THREAD_ID: this.mergedEnv?.THREAD_ID || '',
      CHIRIDION_APP_SESSION: this.mergedEnv?.CHIRIDION_APP_SESSION || '',
    });
    const configChanged =
      previousBaseUrl !== this.baseUrl ||
      previousMcpServerUrl !== this.mcpServerUrl ||
      previousScreenshotSessionToken !== this.screenshotSessionToken ||
      previousEnvSignature !== nextEnvSignature;
    if (configChanged && this.child && this.activeTurns.size === 0) {
      this.dispose();
    }
  }

  dispose() {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.handleExit(new Error('codex app-server stopped.'));
  }

  async runTurn(options) {
    await this.ensureStarted();

    const codexThreadId = await this.ensureThread(options);
    if (this.activeTurns.has(codexThreadId)) {
      throw new Error('A Codex turn is already active for this thread.');
    }

    const resultPromise = new Promise((resolvePromise, rejectPromise) => {
      this.activeTurns.set(codexThreadId, {
        codexThreadId,
        model: options.model,
        state: {
          streamedText: '',
          finalAssistantText: '',
          latestAssistantText: '',
        },
        onEvent: options.onEvent,
        onText: options.onText,
        resolve: resolvePromise,
        reject: rejectPromise,
        settled: false,
      });
    });

    try {
      const response = await this.request('turn/start', {
        threadId: codexThreadId,
        input: [{ type: 'text', text: options.content }],
        cwd: process.cwd(),
        approvalPolicy: 'never',
        model: options.model,
        summary: 'auto',
        personality: 'none',
      });

      if (response?.turn?.status === 'failed') {
        throw new Error(
          typeof response.turn?.error?.message === 'string'
            ? response.turn.error.message
            : 'Codex turn failed.',
        );
      }
    } catch (error) {
      this.failTurn(
        codexThreadId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    return await resultPromise;
  }

  async ensureStarted() {
    if (this.child && this.child.stdin.writable) {
      return;
    }
    if (this.startPromise) {
      await this.startPromise;
      return;
    }
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    await mkdir(this.codexHome, { recursive: true });
    await writeFile(
      `${this.codexHome}/config.toml`,
      buildCodexConfigToml({
        baseUrl: this.baseUrl,
        mcpServerUrl: this.mcpServerUrl,
        screenshotSessionToken: this.screenshotSessionToken,
        threadId: this.threadId,
      }),
      'utf8',
    );

    const child = spawn(this.codexExecutable, ['app-server'], {
      cwd: process.cwd(),
      env: {
        ...this.mergedEnv,
        CODEX_HOME: this.codexHome,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pendingRequests.clear();
    this.knownThreadIds.clear();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk;
      const trimmed = chunk.trim();
      if (trimmed) {
        traceControlPlane('codex_app_server_stderr', {
          threadId: this.threadId,
          data: trimmed.slice(-1000),
        });
      }
    });
    child.on('error', (error) => {
      this.handleExit(
        error instanceof Error ? error : new Error('Failed to start codex app-server.'),
      );
    });
    child.on('close', (code, signal) => {
      this.handleExit(
        new Error(
          this.stderrBuffer.trim() ||
            `codex app-server exited (${signal ?? code ?? 'unknown'}).`,
        ),
      );
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'camelai_web_runtime',
        title: 'camelAI Web Runtime',
        version: '0.1.0',
      },
    });
    this.notify('initialized', {});
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.handleExit(new Error('codex app-server returned invalid JSON.'));
        return;
      }

      if (typeof message.method === 'string') {
        this.handleNotification(message);
      } else {
        this.handleResponse(message);
      }
    }
  }

  handleResponse(message) {
    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message
            ? `${pending.method}: ${message.error.message}`
            : `${pending.method} failed.`,
        ),
      );
      return;
    }
    pending.resolve(message.result);
  }

  handleNotification(message) {
    const params = message.params ?? {};
    const codexThreadId = typeof params.threadId === 'string' ? params.threadId : null;
    const activeTurn = codexThreadId ? this.activeTurns.get(codexThreadId) ?? null : null;

    activeTurn?.onEvent?.(message);

    if (!activeTurn) {
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const delta = params.delta;
      if (typeof delta === 'string' && delta) {
        activeTurn.state.streamedText += delta;
        activeTurn.state.latestAssistantText += delta;
        activeTurn.onText(delta);
      }
      return;
    }

    if (message.method === 'item/completed') {
      const item = params.item;
      if (!item || typeof item !== 'object') {
        return;
      }
      if (item.type === 'agentMessage') {
        const nextText = extractCodexItemText(item);
        if (nextText) {
          activeTurn.state.finalAssistantText = nextText;
          if (
            nextText.startsWith(activeTurn.state.latestAssistantText) &&
            nextText.length > activeTurn.state.latestAssistantText.length
          ) {
            const delta = nextText.slice(activeTurn.state.latestAssistantText.length);
            activeTurn.state.streamedText += delta;
            activeTurn.onText(delta);
          }
          activeTurn.state.latestAssistantText = nextText;
        }
        return;
      }
      if (item.type === 'error') {
        this.failTurn(
          activeTurn.codexThreadId,
          new Error(typeof item.message === 'string' ? item.message : 'Codex turn failed.'),
        );
      }
      return;
    }

    if (message.method === 'error') {
      if (params.willRetry === true) {
        return;
      }
      const error = params.error;
      this.failTurn(
        activeTurn.codexThreadId,
        new Error(
          error && typeof error.message === 'string' ? error.message : 'Codex turn failed.',
        ),
      );
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = params.turn;
      if (turn?.status !== 'completed') {
        this.failTurn(
          activeTurn.codexThreadId,
          new Error(
            turn?.error && typeof turn.error.message === 'string'
              ? turn.error.message
              : 'Codex turn failed.',
          ),
        );
        return;
      }
      this.completeTurn(activeTurn.codexThreadId);
    }
  }

  async ensureThread(options) {
    const existingThreadId = options.sessionId?.trim();
    if (existingThreadId && this.knownThreadIds.has(existingThreadId)) {
      return existingThreadId;
    }

    if (existingThreadId) {
      try {
        const response = await this.request('thread/resume', {
          threadId: existingThreadId,
          cwd: process.cwd(),
          approvalPolicy: 'never',
          sandbox: 'danger-full-access',
          model: options.model,
          developerInstructions: this.developerInstructions,
          personality: 'none',
        });
        const resumedThreadId = response?.thread?.id || existingThreadId;
        this.knownThreadIds.add(resumedThreadId);
        options.onSessionId?.(resumedThreadId);
        return resumedThreadId;
      } catch (error) {
        if (!shouldRetryWithFreshThread(error)) {
          throw error;
        }
      }
    }

    const response = await this.request('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      model: options.model,
      developerInstructions: this.developerInstructions,
      personality: 'none',
    });
    const startedThreadId = response?.thread?.id;
    if (!startedThreadId) {
      throw new Error('Codex did not return a thread id.');
    }
    this.knownThreadIds.add(startedThreadId);
    options.onSessionId?.(startedThreadId);
    return startedThreadId;
  }

  completeTurn(codexThreadId) {
    const activeTurn = this.activeTurns.get(codexThreadId);
    if (!activeTurn || activeTurn.settled) {
      return;
    }
    activeTurn.settled = true;
    this.activeTurns.delete(codexThreadId);
    activeTurn.resolve({
      finalText: activeTurn.state.finalAssistantText || activeTurn.state.streamedText,
      model: activeTurn.model,
      sessionId: codexThreadId,
    });
  }

  failTurn(codexThreadId, error) {
    const activeTurn = this.activeTurns.get(codexThreadId);
    if (!activeTurn || activeTurn.settled) {
      return;
    }
    activeTurn.settled = true;
    this.activeTurns.delete(codexThreadId);
    activeTurn.reject(error);
  }

  notify(method, params) {
    this.send({ method, params });
  }

  async request(method, params) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not running.');
    }
    const id = this.nextRequestId++;
    return await new Promise((resolvePromise, rejectPromise) => {
      this.pendingRequests.set(id, {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
      });
      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        rejectPromise(error instanceof Error ? error : new Error(`${method} failed.`));
      }
    });
  }

  send(message) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not running.');
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleExit(error) {
    if (!this.child && this.pendingRequests.size === 0 && this.activeTurns.size === 0) {
      return;
    }

    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.knownThreadIds.clear();

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }

    for (const [threadId, activeTurn] of this.activeTurns.entries()) {
      this.activeTurns.delete(threadId);
      if (!activeTurn.settled) {
        activeTurn.settled = true;
        activeTurn.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
}

// ─── Chat Session ──────────────────────────────────────────

class ChatSession {
  constructor(threadId, sessionEnv) {
    this.threadId = threadId;
    this.sessionEnv = sessionEnv;
    this.provider = getProviderFromEnv(sessionEnv);
    this.model = getDefaultModelForProvider(this.provider);
    this.codexSessionId =
      typeof sessionEnv?.CHIRIDION_CODEX_SESSION_ID === 'string' &&
      sessionEnv.CHIRIDION_CODEX_SESSION_ID.trim()
        ? sessionEnv.CHIRIDION_CODEX_SESSION_ID.trim()
        : null;
    this.activeQuery = null;
    this.queryIterator = null;
    this.eventLoopRunning = false;
    this.initPromise = null;
    this.messageResolver = null;
    this.messageQueue = [];
    this.pendingQuestions = new Map();
    this.lastForwardedCompactSummaryKey = null;
    this.disconnectTimer = null;
    this.activityGeneration = 0;
    this.hasTerminalResultSinceActivity = false;
    this.clients = new Set();
    this.shuttingDown = false;
    this.activeTurnUserId = null;
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
    this.activeCodexTurnPromise = null;
    this.codexClient = null;
  }

  updateSessionEnv(nextSessionEnv) {
    const incoming = nextSessionEnv && typeof nextSessionEnv === 'object' ? nextSessionEnv : {};
    this.sessionEnv = {
      ...this.sessionEnv,
      ...incoming,
    };
    this.provider = getProviderFromEnv(this.sessionEnv);
    this.model = getDefaultModelForProvider(this.provider);
    if (
      typeof this.sessionEnv.CHIRIDION_CODEX_SESSION_ID === 'string' &&
      this.sessionEnv.CHIRIDION_CODEX_SESSION_ID.trim()
    ) {
      this.codexSessionId = this.sessionEnv.CHIRIDION_CODEX_SESSION_ID.trim();
    }
    if (this.codexClient) {
      this.codexClient.updateSessionEnv(this.sessionEnv);
    }
  }

  normalizeTurnUserId(userId) {
    return typeof userId === 'string' && userId.trim() ? userId.trim() : null;
  }

  setActiveTurnUserId(userId, source) {
    const normalizedUserId = this.normalizeTurnUserId(userId);
    if (this.activeTurnUserId === normalizedUserId) {
      return;
    }

    this.activeTurnUserId = normalizedUserId;
    this.broadcast({
      type: 'active_turn_identity',
      userId: normalizedUserId,
      source,
    });
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
    this.setActiveTurnUserId(null, 'shutdown');
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
    this.activeCodexTurnPromise = null;
    if (this.codexClient) {
      this.codexClient.dispose();
      this.codexClient = null;
    }
  }

  getCodexClient() {
    if (!this.codexClient) {
      this.codexClient = new CodexAppServerClient(this.threadId, this.sessionEnv);
    }
    return this.codexClient;
  }

  async sessionFileExists() {
    if (!this.threadId) return false;
    const projectPath = process.cwd().replace(/\//g, '-');
    const jsonlPath = `${CLAUDE_CONFIG_DIR}/projects/${projectPath}/${this.threadId}.jsonl`;
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
    const answers = await this.askUserQuestions(questions, toolUseId, questionId);
    return { behavior: 'allow', updatedInput: { questions, answers } };
  }

  async askUserQuestions(questions, toolUseId = undefined, questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`) {
    const answerPromise = new Promise((resolve) => {
      this.pendingQuestions.set(questionId, { questionId, toolUseId, questions, resolve });
    });

    this.clearDisconnect();
    this.broadcast({ type: 'ask_user_question', questionId, toolUseId, questions });
    return await answerPromise;
  }

  handleQuestionResponse(questionId, answers, userId = null) {
    this.markUserActivity('question_response');
    const pending = this.pendingQuestions.get(questionId);
    if (!pending) return;
    this.pendingQuestions.delete(questionId);
    this.setActiveTurnUserId(userId, 'question_response');
    pending.resolve(answers);
    traceControlPlane('session_question_answered', {
      threadId: this.threadId,
      questionId,
      pendingQuestions: this.pendingQuestions.size,
    });
    this.broadcast({ type: 'question_answered', questionId });
  }

  getQueryOptions(fileExists) {
    if (this.provider !== 'claude') {
      throw new Error('Claude query options requested for a non-Claude session.');
    }
    const mergedEnv = {
      ...buildThreadScopedEnv(this.sessionEnv, this.threadId),
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
    };

    const mcpServerUrl = mergedEnv.MCP_SERVER_URL;
    const mcpServers = {};
    if (mcpServerUrl) {
      mcpServers.camelai = {
        type: 'http',
        url: mcpServerUrl,
      };
    }

    // In-process MCP server for Playwright screenshots (no separate process)
    mcpServers.screenshot = createScreenshotMcpServer(mergedEnv.CHIRIDION_APP_SESSION);

    const systemAppend = buildSystemPromptAppend('claude').trim();

    const configuredModel = mergedEnv.CHIRIDION_CLAUDE_MODEL === 'opus' ? 'opus' : 'sonnet';

    const options = {
      // Force Node as the runtime executable — Bun has a bug that breaks the SDK.
      executable: 'node',
      model: configuredModel,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowUnsandboxedCommands: true,
      canUseTool: (name, input, opts) => this.handleCanUseTool(name, input, opts),
      ...(Object.keys(mcpServers).length > 0 && {
        mcpServers,
        allowedTools: ['mcp__camelai__*', 'mcp__screenshot__*'],
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
          messageLength: typeof message?.content === 'string' ? message.content.length : 0,
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
              messageLength: typeof message?.content === 'string' ? message.content.length : 0,
            });
          } else {
            return;
          }
        }
      }
      if (!message || typeof message.content !== 'string' || !message.content) continue;
      this.setActiveTurnUserId(message.userId, 'claude_message_start');
      yield { type: 'user', message: { role: 'user', content: message.content } };
    }
  }

  async init() {
    if (this.provider !== 'claude') {
      return;
    }

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
          fileCheckMs: Math.round(tFileCheck - t0),
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
    const jsonlPath = `${CLAUDE_CONFIG_DIR}/projects/${projectPath}/${this.threadId}.jsonl`;
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
    if (this.provider !== 'claude' || this.eventLoopRunning || !this.queryIterator) return;
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
            this.setActiveTurnUserId(null, 'claude_turn_complete');
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
        this.setActiveTurnUserId(null, 'claude_turn_error');
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

  async handleCodexMessage(trimmed, userId = null) {
    if (this.activeCodexTurnPromise) {
      throw new Error('A Codex response is already streaming for this thread.');
    }

    this.setActiveTurnUserId(userId, 'codex_turn_start');
    const runPromise = this.getCodexClient().runTurn({
      threadId: this.threadId,
      content: trimmed,
      model: this.model,
      sessionId: this.codexSessionId,
      onEvent: (event) => {
        this.broadcast({ type: 'runtime_event', event });
        const todos = extractCodexTodosFromRuntimeEvent(event);
        if (Array.isArray(todos)) {
          this.broadcast({ type: 'todo_state', todos });
        }
      },
      onText: (delta) => {
        this.broadcast({ type: 'assistant_delta', threadId: this.threadId, text: delta });
      },
      onSessionId: (sessionId) => {
        this.codexSessionId = sessionId;
        this.broadcast({ type: 'session_id', threadId: this.threadId, sessionId });
      },
    });

    this.activeCodexTurnPromise = runPromise;

    try {
      const result = await runPromise;
      if (result?.sessionId) {
        this.codexSessionId = result.sessionId;
      }
      this.markTerminalResult();
      this.broadcast({
        type: 'result',
        threadId: this.threadId,
        result: result?.finalText || '',
        sessionId: result?.sessionId || this.codexSessionId || undefined,
      });
      this.setActiveTurnUserId(null, 'codex_turn_complete');
    } catch (error) {
      this.broadcast({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        source: 'codex_app_server',
      });
      this.setActiveTurnUserId(null, 'codex_turn_error');
    } finally {
      this.activeCodexTurnPromise = null;
      this.scheduleDisconnectIfIdleEligible('codex_turn_complete');
    }
  }

  async handleMessage(content, userId = null) {
    if (typeof content !== 'string' || !content.trim()) return;
    traceControlPlane('session_handle_message', {
      threadId: this.threadId,
      contentLength: content.trim().length,
      hasResolver: Boolean(this.messageResolver),
      queueLength: this.messageQueue.length,
      clientCount: this.clients.size,
    });
    this.markUserActivity('message');

    if (this.provider === 'codex') {
      await this.handleCodexMessage(content.trim(), userId);
      return;
    }

    await this.init();
    this.startEventLoop();

    if (this.messageResolver) {
      const r = this.messageResolver;
      this.messageResolver = null;
      r({ content: content.trim(), userId: this.normalizeTurnUserId(userId) });
    } else {
      this.messageQueue.push({
        content: content.trim(),
        userId: this.normalizeTurnUserId(userId),
      });
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
    if (this.provider !== 'claude') {
      return;
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

    if (url.pathname === '/internal/ask-user-question' && req.method === 'POST') {
      try {
        const body = await req.json();
        const threadId = typeof body?.threadId === 'string' ? body.threadId.trim() : '';
        const questions = Array.isArray(body?.questions) ? body.questions : [];
        if (!threadId) {
          return errorResponse('threadId required', 400);
        }
        if (questions.length === 0) {
          return errorResponse('questions required', 400);
        }
        const session = chatSessions.get(threadId);
        if (!session) {
          return errorResponse('session not found', 404);
        }
        const answers = await session.askUserQuestions(questions);
        return jsonResponse({ answers });
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
        session.handleMessage(msg.content, msg.userId).catch((err) => {
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
          session.handleQuestionResponse(msg.questionId, msg.answers, msg.userId);
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
