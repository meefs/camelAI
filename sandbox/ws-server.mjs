import { query } from '@anthropic-ai/claude-agent-sdk';
import { appendFile, mkdir, access, stat, readFile } from 'fs/promises';
import os from 'os';

// Version for verifying container has latest code
const VERSION = '2026-01-23-sandbox-v26-message-queue';

/**
 * MessageQueue - Similar to SDK's internal QX class.
 * Key property: next() returns a Promise that waits indefinitely until
 * enqueue() or close() is called. This prevents streamInput from calling
 * endInput() prematurely (which closes stdin and causes early exit).
 */
class MessageQueue {
  #queue = [];
  #waitingResolve = null;
  #waitingReject = null;
  #closed = false;
  #started = false;

  [Symbol.asyncIterator]() {
    if (this.#started) throw new Error('MessageQueue can only be iterated once');
    this.#started = true;
    return this;
  }

  next() {
    // If there are queued messages, return immediately
    if (this.#queue.length > 0) {
      return Promise.resolve({ done: false, value: this.#queue.shift() });
    }
    // If closed, signal done
    if (this.#closed) {
      return Promise.resolve({ done: true, value: undefined });
    }
    // Wait for next enqueue() or close() - this is the key difference!
    // This Promise stays pending until something happens, preventing
    // the for-await loop from completing.
    return new Promise((resolve, reject) => {
      this.#waitingResolve = resolve;
      this.#waitingReject = reject;
    });
  }

  enqueue(value) {
    if (this.#closed) return;
    if (this.#waitingResolve) {
      const resolve = this.#waitingResolve;
      this.#waitingResolve = null;
      this.#waitingReject = null;
      resolve({ done: false, value });
    } else {
      this.#queue.push(value);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#waitingResolve) {
      const resolve = this.#waitingResolve;
      this.#waitingResolve = null;
      this.#waitingReject = null;
      resolve({ done: true, value: undefined });
    }
  }

  get length() {
    return this.#queue.length;
  }

  get isClosed() {
    return this.#closed;
  }
}

// Single-line logging helpers (CF treats each line as separate log entry)
function log(prefix, message, data) {
  if (data !== undefined) {
    console.log(`${prefix} ${message} ${JSON.stringify(data)}`);
  } else {
    console.log(`${prefix} ${message}`);
  }
}

function logError(prefix, message, data) {
  if (data !== undefined) {
    console.error(`${prefix} ${message} ${JSON.stringify(data)}`);
  } else {
    console.error(`${prefix} ${message}`);
  }
}

// Configuration from environment
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WORKER_BASE_URL = process.env.WORKER_BASE_URL;
const MCP_SERVER_URL = process.env.MCP_SERVER_URL; // e.g., https://worker.chiridion.ai/mcp
const MCP_API_KEY = process.env.MCP_API_KEY; // API key with 'mcp' scope
const PORT = 8080;
const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
const TRACE_EVENTS = process.env.CHIRIDION_TRACE_EVENTS !== '0';
const TRACE_DIR = `${SYNC_DIR}/.chiridion/trace`;
const TRACE_ALL_FILE = `${TRACE_DIR}/_all.ndjson`;
const TASK_RESULTS_DIR = `${SYNC_DIR}/.chiridion/task-results`;
const CLAUDE_DEBUG_DIR = `${SYNC_DIR}/.claude/debug`;
const DEBUG_STARTUP = process.env.CHIRIDION_DEBUG_STARTUP === '1';
const DEBUG_SDK = process.env.CHIRIDION_DEBUG_SDK === '1';
const DEBUG_FS = process.env.CHIRIDION_DEBUG_FS === '1';
const DEBUG_PROXY = process.env.CHIRIDION_DEBUG_PROXY === '1';
const PREQUEUE_FIRST_MESSAGE = process.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE === '1';
const FIRST_MESSAGE_DELAY_MS = Number(process.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS || '100') || 0;

log('[ws-server]', 'Starting', { version: VERSION, port: PORT });

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

// Session state - keyed by threadId
const sessions = new Map();
const MAX_EVENT_BUFFER = 500;
let traceDirPromise = null;
let taskResultsDirPromise = null;
let startupDiagnosticsPromise = null;

// Integration env vars cache - pushed by worker when integrations change
// Keys are INT_* prefixed env var names, values are the credential values
let integrationEnvVars = {};

function sanitizeFileSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function ensureTraceDir() {
  if (!traceDirPromise) {
    traceDirPromise = mkdir(TRACE_DIR, { recursive: true }).catch((err) => {
      logError('[ws-server]', 'Failed to create trace dir:', err?.message || String(err));
    });
  }
  return traceDirPromise;
}

function ensureTaskResultsDir() {
  if (!taskResultsDirPromise) {
    taskResultsDirPromise = mkdir(TASK_RESULTS_DIR, { recursive: true }).catch((err) => {
      logError('[ws-server]', 'Failed to create task results dir:', err?.message || String(err));
    });
  }
  return taskResultsDirPromise;
}

async function probePath(label, path) {
  try {
    const info = await stat(path);
    log('[ws-server]', 'fs_probe', {
      label,
      path,
      isFile: info.isFile(),
      isDirectory: info.isDirectory(),
      size: info.size,
      mode: info.mode,
    });
  } catch (error) {
    logError('[ws-server]', 'fs_probe_failed', { label, path, error: error?.message || String(error) });
  }
}

async function probeFilesystem() {
  try {
    await mkdir(SYNC_DIR, { recursive: true });
  } catch (error) {
    logError('[ws-server]', 'fs_probe_mkdir_failed', { path: SYNC_DIR, error: error?.message || String(error) });
  }

  await probePath('sync_dir', SYNC_DIR);
  await probePath('claude_dir', `${SYNC_DIR}/.claude`);
  await probePath('claude_projects_dir', `${SYNC_DIR}/.claude/projects`);
  await probePath('chiridion_dir', `${SYNC_DIR}/.chiridion`);

  try {
    await ensureTraceDir();
    const probePathFile = `${TRACE_DIR}/startup-probe.ndjson`;
    const line = `${JSON.stringify({ at: new Date().toISOString(), ok: true })}\n`;
    await appendFile(probePathFile, line);
    log('[ws-server]', 'fs_probe_write_ok', { path: probePathFile });
  } catch (error) {
    logError('[ws-server]', 'fs_probe_write_failed', { path: TRACE_DIR, error: error?.message || String(error) });
  }
}

async function tailFile(path, maxBytes = 12000) {
  try {
    const data = await readFile(path);
    if (!data || data.length === 0) return null;
    const slice = data.length > maxBytes ? data.subarray(data.length - maxBytes) : data;
    const text = new TextDecoder().decode(slice);
    // Keep the last ~40 lines to avoid flooding logs.
    const lines = text.trim().split('\n');
    const tail = lines.slice(-40).join('\n');
    return tail || null;
  } catch (error) {
    return null;
  }
}

async function logClaudeDebugTail(threadId, reason) {
  if (!threadId) return;
  const debugPath = `${CLAUDE_DEBUG_DIR}/${threadId}.txt`;
  const tail = await tailFile(debugPath);
  if (tail) {
    log('[ws-server]', 'claude_debug_tail', { threadId, reason, path: debugPath });
    console.log(tail);
  } else {
    log('[ws-server]', 'claude_debug_tail_missing', { threadId, reason, path: debugPath });
  }
}

async function probeProxyBaseUrl() {
  const baseUrl = process.env.ANTHROPIC_BASE_URL;
  if (!baseUrl) {
    logError('[ws-server]', 'proxy_probe_skipped', { reason: 'ANTHROPIC_BASE_URL not set' });
    return;
  }
  const trimmed = baseUrl.replace(/\/$/, '');
  const candidates = [`${trimmed}/proxy/health`, `${trimmed}/health`];
  for (const target of candidates) {
    try {
      const res = await fetch(target, { method: 'GET' });
      log('[ws-server]', 'proxy_probe', { url: target, status: res.status });
      if (res.ok || res.status === 404) {
        return;
      }
    } catch (error) {
      logError('[ws-server]', 'proxy_probe_failed', { url: target, error: error?.message || String(error) });
    }
  }
}

async function runStartupDiagnostics() {
  if (startupDiagnosticsPromise) return startupDiagnosticsPromise;
  startupDiagnosticsPromise = (async () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : null;
    const gid = typeof process.getgid === 'function' ? process.getgid() : null;
    const envSnapshot = {
      cwd: process.cwd(),
      home: typeof os.homedir === 'function' ? os.homedir() : process.env.HOME || null,
      user: process.env.USER || null,
      uid,
      gid,
      syncDir: SYNC_DIR,
      traceDir: TRACE_DIR,
      taskResultsDir: TASK_RESULTS_DIR,
      anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || null,
      anthropicKeyLen: (process.env.ANTHROPIC_API_KEY || '').length,
      mcpServerUrl: MCP_SERVER_URL || null,
      mcpKeyLen: (MCP_API_KEY || '').length,
      bunVersion: typeof Bun !== 'undefined' ? Bun.version : null,
      nodeVersion: process.version,
    };
    log('[ws-server]', 'startup_env', envSnapshot);

    if (DEBUG_FS) {
      await probeFilesystem();
    }
    if (DEBUG_PROXY) {
      await probeProxyBaseUrl();
    }
  })();
  return startupDiagnosticsPromise;
}

async function writeTrace(threadId, entry) {
  if (!TRACE_EVENTS) return;
  try {
    await ensureTraceDir();
    const safeThread = sanitizeFileSegment(threadId);
    const tracePath = `${TRACE_DIR}/${safeThread}.ndjson`;
    const line = `${JSON.stringify({ at: new Date().toISOString(), threadId, ...entry })}\n`;
    await appendFile(tracePath, line);
    await appendFile(TRACE_ALL_FILE, line);
  } catch (error) {
    logError('[ws-server]', 'Trace write failed:', error?.message || String(error));
  }
}

function extractParentToolUseId(event) {
  if (!event || typeof event !== 'object') return null;
  const record = event;
  const message = record.message || {};
  const parent = (
    record.parent_tool_use_id ??
    record.source_tool_use_id ??
    record.parentToolUseId ??
    record.sourceToolUseId ??
    message.parent_tool_use_id ??
    message.source_tool_use_id ??
    message.parentToolUseId ??
    message.sourceToolUseId
  );
  return typeof parent === 'string' ? parent : null;
}

function extractParentToolPrompt(event) {
  if (!event || typeof event !== 'object') return null;
  const toolUseResult = event.toolUseResult || event.tool_use_result || null;
  const prompt = toolUseResult?.prompt;
  return typeof prompt === 'string' ? prompt : null;
}

async function writeTaskResultUpdate(threadId, entry) {
  if (!threadId) return;
  try {
    await ensureTaskResultsDir();
    const taskPath = `${TASK_RESULTS_DIR}/${threadId || 'unknown'}.jsonl`;
    const line = `${JSON.stringify({ at: new Date().toISOString(), threadId, ...entry })}\n`;
    await appendFile(taskPath, line);
  } catch (error) {
    logError('[ws-server]', 'Task update write failed:', error?.message || String(error));
  }
}

function persistTaskResultUpdates(session, event) {
  if (!session?.threadId) return;
  if (!event || event.type !== 'user') return;
  const content = event.message?.content;
  if (!Array.isArray(content)) return;
  const toolResults = content.filter((block) => block?.type === 'tool_result' && block.tool_use_id);
  if (toolResults.length === 0) return;
  const parentToolUseId = extractParentToolUseId(event);
  const parentToolPrompt = extractParentToolPrompt(event);
  const parentIsTask = parentToolUseId
    ? session.taskToolUseIds?.has(parentToolUseId)
    : Boolean(parentToolPrompt);
  if (!parentIsTask) return;
  const timestamp = event.timestamp || new Date().toISOString();

  toolResults.forEach((toolResult, index) => {
    if (session.taskToolUseIds?.has(toolResult.tool_use_id)) return;
    if (parentToolUseId && toolResult.tool_use_id === parentToolUseId) return;
    if (!parentToolUseId && !parentToolPrompt) return;
    void writeTaskResultUpdate(session.threadId, {
      type: 'task_update',
      parent_tool_use_id: parentToolUseId,
      parent_tool_prompt: parentToolPrompt,
      tool_use_id: toolResult.tool_use_id,
      content: toolResult.content,
      timestamp,
      index,
    });
  });
}

function trackTaskToolUse(session, event) {
  if (!session) return;
  if (!event || typeof event !== 'object') return;

  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    event.message.content.forEach((block) => {
      if (block?.type === 'tool_use' && block.name === 'Task' && block.id) {
        session.taskToolUseIds.add(block.id);
      }
    });
  }

  if (event.type === 'stream_event' && event.event?.type === 'content_block_start') {
    const block = event.event.content_block;
    if (block?.type === 'tool_use' && block.name === 'Task' && block.id) {
      session.taskToolUseIds.add(block.id);
    }
  }
}

function createSession(threadId, threadDeployToken = null, userInfo = null) {
  const session = {
    threadId,
    threadDeployToken, // Per-thread token for auto-preview after deploys
    userName: userInfo?.userName || null,
    userEmail: userInfo?.userEmail || null,
    activeQuery: null,
    queryIterator: null,
    initPromise: null,
    queryId: 0,
    earlyExitRetries: 0,
    lastUserMessage: null,
    lastStopRequestedAt: 0,
    eventLoopRunning: false,
    // MessageQueue replaces messageResolver + messageQueue array
    // It never returns done:true until explicitly closed, preventing early stdin close
    inputQueue: new MessageQueue(),
    attachedSockets: new Set(),
    eventBuffer: [],
    nextEventId: 1,
    taskToolUseIds: new Set(),
    eventTypeHistory: [],
  };
  sessions.set(threadId, session);
  return session;
}

function getOrCreateSession(threadId, threadDeployToken = null, userInfo = null) {
  if (!threadId) {
    threadId = crypto.randomUUID();
  }
  if (sessions.has(threadId)) {
    const session = sessions.get(threadId);
    // Update token if provided (new connection for existing session)
    if (threadDeployToken && !session.threadDeployToken) {
      session.threadDeployToken = threadDeployToken;
    }
    // Update user info if provided (new connection for existing session)
    if (userInfo?.userName && !session.userName) {
      session.userName = userInfo.userName;
    }
    if (userInfo?.userEmail && !session.userEmail) {
      session.userEmail = userInfo.userEmail;
    }
    if (!session.taskToolUseIds) {
      session.taskToolUseIds = new Set();
    }
    return session;
  }
  return createSession(threadId, threadDeployToken, userInfo);
}

// Log for DO persistence (NDJSON format)
// Use stderr with a special prefix that DO can parse
// Note: stdout may not be captured correctly in Cloudflare Container environments
const PERSIST_PREFIX = '[PERSIST]';
function logForPersistence(event) {
  const line = JSON.stringify(event);
  console.error(`${PERSIST_PREFIX}${line}`);
}

function summarizeError(error) {
  if (!error || typeof error !== 'object') {
    return { message: String(error) };
  }
  return {
    message: String(error),
    name: error.name,
    stack: error.stack,
    cause: error.cause ? String(error.cause) : undefined,
  };
}

process.on('uncaughtException', (error) => {
  logError('[ws-server]', 'Uncaught exception:', summarizeError(error));
});

process.on('unhandledRejection', (error) => {
  logError('[ws-server]', 'Unhandled rejection:', summarizeError(error));
});

// Track total connection count for lifecycle logging
let totalConnections = 0;
let serverStartTime = Date.now();

// Periodic status logging (every 5 minutes)
const STATUS_LOG_INTERVAL = 5 * 60 * 1000;
setInterval(() => {
  const uptimeMs = Date.now() - serverStartTime;
  const uptimeMins = Math.floor(uptimeMs / 60000);
  const sessionCount = sessions.size;
  let activeSocketCount = 0;
  for (const session of sessions.values()) {
    activeSocketCount += session.attachedSockets?.size || 0;
  }
  log('[ws-server]', 'STATUS', {
    uptimeMins,
    sessions: sessionCount,
    activeSockets: activeSocketCount,
    totalConnectionsEver: totalConnections,
  });
}, STATUS_LOG_INTERVAL);

process.on('exit', (code) => {
  log('[ws-server]', `Process exiting code=${code}`, {
    uptimeSecs: Math.floor((Date.now() - serverStartTime) / 1000),
    sessions: sessions.size,
  });
});

process.on('SIGTERM', () => {
  log('[ws-server]', 'Received SIGTERM signal');
});

process.on('SIGINT', () => {
  log('[ws-server]', 'Received SIGINT signal');
});

// Check if a session JSONL file exists (async version)
async function sessionFileExists(sessionId) {
  if (!sessionId) return false;
  const projectPath = '-home-claude';
  const jsonlPath = `${SYNC_DIR}/.claude/projects/${projectPath}/${sessionId}.jsonl`;
  const start = Date.now();
  let exists = false;
  try {
    await access(jsonlPath);
    exists = true;
  } catch {
    exists = false;
  }
  const durationMs = Date.now() - start;
  log('[ws-server]', 'sessionFileExists', { sessionId, path: jsonlPath, exists, durationMs });
  return exists;
}

// Query options for Claude SDK
function getQueryOptions(session, fileExists) {
  // Build env vars, merging:
  // 1. Base process.env (set at container startup)
  // 2. Integration env vars (pushed by worker when integrations change)
  // 3. Per-thread overrides (deploy token, thread ID)
  const envVars = {
    ...process.env,
    ...integrationEnvVars, // INT_* vars pushed by worker
    THREAD_ID: session.threadId || '',
  };

  // Use per-thread deploy token if available (preferred for auto-preview)
  // Falls back to container's org-level token if not available
  if (session.threadDeployToken) {
    envVars.CLOUDFLARE_API_TOKEN = session.threadDeployToken;
  }

  // Build MCP servers configuration if MCP_SERVER_URL is set
  const mcpServers = {};
  if (MCP_SERVER_URL && MCP_API_KEY) {
    mcpServers['chiridion'] = {
      type: 'http',
      url: MCP_SERVER_URL,
      headers: {
        Authorization: `Bearer ${MCP_API_KEY}`,
      },
    };
  }

  const options = {
    model: 'opus',
    fallbackModel: 'sonnet',
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    stderr: (data) => {
      const message = String(data || '').trim();
      if (!message) return;
      logError('[ws-server]', 'cli_stderr', {
        threadId: session.threadId,
        message: message.slice(0, 2000),
      });
    },
    // MCP server configuration
    ...(Object.keys(mcpServers).length > 0 && {
      mcpServers,
      allowedTools: ['mcp__chiridion__*'], // Allow all tools from chiridion MCP server
    }),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: `
## About This Environment

You are running inside **Chiridion**, a web application that brings Claude Code to the browser. Users interact through a chat interface - they cannot see your terminal, localhost servers, or file system directly.

**Important constraints:**
- **localhost is not accessible** - Users cannot open localhost URLs. If you need to show something, deploy it or output the content directly.
- **Don't assume technical ability** - Users may not be developers. Explain what you're doing in plain language. Avoid jargon unless the user demonstrates familiarity.
- **Show results, not processes** - Instead of saying "run npm start and open localhost:3000", deploy the app or show the output directly.

## Multi-User Threads

Threads in Chiridion can have multiple users. Each user message is prefixed with the sender's identity in the format \`[Name (email)]: message\` or \`[email]: message\`. Pay attention to who is sending each message - different team members may have different questions or instructions.

## File Sharing with User

You have access to two special directories for exchanging files with the user:

- **\`/mnt/user-uploads/\`** - Files uploaded by the user. When a user uploads a file, you'll see a message like "(user uploaded file to /mnt/user-uploads/filename.png)". Read files from this directory to access what they shared.

- **\`/mnt/user-outputs/\`** - Files you create for the user to download. Save files here when you want the user to be able to download them.

**Creating downloadable files:**
When you save a file for the user to download in /mnt/user-outputs/, provide a link using the chiridion:// protocol:
- Format: \`[Link Text](chiridion://outputs/filename)\`
- Example: \`[Download Report](chiridion://outputs/report.pdf)\`
- Example: \`[Download Chart](chiridion://outputs/analysis/chart.png)\`

The user can click these links to download the file directly.

## Cloudflare Deployment

When deploying software to the internet or for the user to access:

1. **Always use the globally installed \`wrangler\` CLI** - Do not install wrangler locally via npm
2. **Build as Cloudflare Workers** - All deployable software should be written as Workers
3. **Use Durable Objects with SQLite** - For persistence, use SQLite-backed Durable Objects (not KV)
4. **Use \`wrangler deploy\`** - Deploy with the global wrangler binary

The infrastructure is already configured for Worker deployments. For fullstack apps, use Next.js with OpenNext for Cloudflare.
`.trim(),
    },
    settingSources: ['project', 'user'],
    env: envVars,
  };

  if (session.threadId) {
    if (fileExists) {
      options.resume = session.threadId;
    } else {
      options.extraArgs = { 'session-id': session.threadId };
    }
  }

  if (DEBUG_SDK) {
    log('[ws-server]', 'query_options', {
      threadId: session.threadId,
      resume: Boolean(options.resume),
      hasExtraArgs: Boolean(options.extraArgs),
      model: options.model,
      fallbackModel: options.fallbackModel,
      includePartialMessages: options.includePartialMessages,
      permissionMode: options.permissionMode,
      allowUnsandboxedCommands: options.allowUnsandboxedCommands,
      mcpServers: Object.keys(mcpServers || {}),
      envKeys: Object.keys(envVars || {}).length,
    });
  }

  return options;
}

// Async generator that yields user messages from the MessageQueue.
// The queue's next() waits indefinitely until enqueue() or close() is called,
// which prevents streamInput from calling endInput() prematurely.
async function* createMessageStream(session) {
  log('[ws-server]', 'messageStream_start', { threadId: session.threadId });
  let isFirstMessage = true;
  try {
    // Iterate the MessageQueue - this will wait indefinitely for messages
    for await (const message of session.inputQueue) {
      log('[ws-server]', 'messageStream_received', {
        threadId: session.threadId,
        contentLength: typeof message === 'string' ? message.length : null,
        queueLength: session.inputQueue.length,
      });

      // Short delay before first message to let SDK fully initialize
      if (isFirstMessage && FIRST_MESSAGE_DELAY_MS > 0) {
        await Bun.sleep(FIRST_MESSAGE_DELAY_MS);
        isFirstMessage = false;
      }

      // Yield the user message
      log('[ws-server]', 'messageStream_yield', {
        threadId: session.threadId,
        contentLength: typeof message === 'string' ? message.length : null,
      });
      yield {
        type: 'user',
        message: {
          role: 'user',
          content: message,
        },
      };
    }
  } catch (error) {
    logError('[ws-server]', 'messageStream_error', { threadId: session.threadId, error: summarizeError(error) });
    throw error;
  }

  log('[ws-server]', 'messageStream_done', { threadId: session.threadId });
}

function bufferEvent(session, payload) {
  if (!session.attachedSockets) {
    session.attachedSockets = new Set();
  }
  const eventId = session.nextEventId++;
  const envelope = { ...payload, eventId, sessionId: session.threadId };
  session.eventBuffer.push(envelope);
  void writeTrace(session.threadId, { direction: 'ws_out', payload: envelope });
  if (session.eventBuffer.length > MAX_EVENT_BUFFER) {
    session.eventBuffer.shift();
  }
  if (session.attachedSockets.size > 0) {
    for (const socket of session.attachedSockets) {
      try {
        socket.send(JSON.stringify(envelope));
      } catch (e) {
        logError('[ws-server]', 'Failed to send event:', String(e));
        session.attachedSockets.delete(socket);
      }
    }
  }
  return envelope;
}

function replayBufferedEvents(session, ws, lastEventId) {
  const fromId = Number.isFinite(lastEventId) ? lastEventId : 0;
  let replayed = 0;
  for (const envelope of session.eventBuffer) {
    if (envelope.eventId > fromId) {
      try {
        ws.send(JSON.stringify(envelope));
        replayed++;
      } catch (e) {
        logError('[ws-server]', 'Failed to replay event:', String(e));
        break;
      }
    }
  }
  if (replayed > 0) {
    void writeTrace(session.threadId, { direction: 'ws_out_replay', count: replayed, fromEventId: fromId });
  }
}

function attachSession(ws, session, lastEventId) {
  if (!session.attachedSockets) {
    session.attachedSockets = new Set();
  }
  session.attachedSockets.add(ws);
  // Preserve existing ws.data (userName, userEmail, threadDeployToken) and add threadId
  ws.data = { ...ws.data, threadId: session.threadId };

  // Send the threadId to the client - they may have provided it or we generated it
  if (session.threadId) {
    ws.send(JSON.stringify({ type: 'session', sessionId: session.threadId }));
  }

  ws.send(JSON.stringify({ type: 'ready' }));
  replayBufferedEvents(session, ws, lastEventId);
  log('[ws-server]', 'attachSession', {
    threadId: session.threadId,
    lastEventId,
    attachedSockets: session.attachedSockets.size,
  });
}

// Initialize the stateful query session
async function initSession(session) {
  if (session.activeQuery) {
    log('[ws-server]', 'initSession_skip_active', { threadId: session.threadId });
    return;
  }
  if (session.initPromise) {
    log('[ws-server]', 'initSession_skip_inflight', { threadId: session.threadId });
    await session.initPromise;
    return;
  }

  session.initPromise = (async () => {
    const initStart = Date.now();
    log('[ws-server]', 'initSession_start', { threadId: session.threadId });
    try {
      if (DEBUG_STARTUP) {
        await runStartupDiagnostics();
      }
      const fileExists = await sessionFileExists(session.threadId);
      const options = getQueryOptions(session, fileExists);
      const messageStream = createMessageStream(session);
      session.activeQuery = query({ prompt: messageStream, options });
      session.queryIterator = session.activeQuery[Symbol.asyncIterator]();
      session.queryId += 1;
      log('[ws-server]', 'initSession', {
        threadId: session.threadId,
        resume: fileExists,
        durationMs: Date.now() - initStart,
        queryId: session.queryId,
      });
    } catch (error) {
      logError('[ws-server]', 'Failed to init:', summarizeError(error));
      bufferEvent(session, { type: 'error', error: `Failed to initialize session: ${String(error)}` });
    }
  })();

  try {
    await session.initPromise;
  } finally {
    session.initPromise = null;
  }
}

// Start continuous event loop - runs until query ends or error
function startEventLoop(session) {
  if (session.eventLoopRunning || !session.queryIterator) {
    return;
  }
  session.eventLoopRunning = true;
  const eventLoopQueryId = session.queryId;
  let hadNonSystemEvent = false;

  (async () => {
    let exitReason = 'unknown';
    let eventCount = 0;
    const loopStart = Date.now();
    let firstEventAt = null;
    try {
      while (true) {
        const { value: event, done } = await session.queryIterator.next();
        eventCount++;

        if (done) {
          exitReason = 'iterator_done';
          break;
        }

        if (!firstEventAt) {
          firstEventAt = Date.now();
          log('[ws-server]', 'first_event', {
            threadId: session.threadId,
            afterMs: firstEventAt - loopStart,
            eventType: event?.type,
            eventSubType: event?.event?.type,
          });
        }

        const eventType = event?.type;
        const eventSubType = event?.event?.type;
        if (eventType && eventType !== 'system') {
          hadNonSystemEvent = true;
          session.earlyExitRetries = 0;
        }
        if (session.eventTypeHistory) {
          session.eventTypeHistory.push({ type: eventType, subType: eventSubType });
          if (session.eventTypeHistory.length > 20) {
            session.eventTypeHistory.shift();
          }
        }

        log('[ws-server]', 'sdk_event', {
          threadId: session.threadId,
          eventType,
          eventSubType,
          systemSubType: eventType === 'system' ? event?.subtype || event?.message?.subtype || event?.message?.type : null,
        });

        // Send event to client via WebSocket (or buffer if detached)
        bufferEvent(session, { type: 'sdk_event', event });
        trackTaskToolUse(session, event);
        persistTaskResultUpdates(session, event);

        // Result means this turn is done - but keep loop alive if sockets connected or messages pending
        if (eventType === 'result') {
          log('[ws-server]', 'sdk_result', {
            threadId: session.threadId,
            stopReason: event?.stop_reason || event?.message?.stop_reason || null,
            status: event?.status || event?.message?.status || null,
          });
          const hasConnections = session.attachedSockets && session.attachedSockets.size > 0;
          const hasPendingMessages = session.inputQueue.length > 0;
          if (!hasConnections && !hasPendingMessages) {
            exitReason = 'no_connections_or_messages';
            break;
          }
          // Continue looping - generator will yield queued message or wait for new one
        }
      }
    } catch (e) {
      exitReason = 'error';
      logError('[ws-server]', 'Query error:', summarizeError(e));
      bufferEvent(session, { type: 'error', error: String(e) });
      void writeTrace(session.threadId, { direction: 'error', error: String(e) });
      logForPersistence({ type: 'error', error: String(e) });
      // Snapshot sync happens on container shutdown via entrypoint cleanup.
    } finally {
      session.activeQuery = null;
      session.queryIterator = null;
      session.eventLoopRunning = false;
      log('[ws-server]', 'event_loop_exit', {
        threadId: session.threadId,
        exitReason,
        eventCount,
        durationMs: Date.now() - loopStart,
        hadFirstEvent: Boolean(firstEventAt),
        lastEvents: session.eventTypeHistory || [],
        queryId: eventLoopQueryId,
      });

      const hasConnections = session.attachedSockets && session.attachedSockets.size > 0;
      const stopCooldownMs = 5000;
      const stopRecently = session.lastStopRequestedAt
        ? Date.now() - session.lastStopRequestedAt < stopCooldownMs
        : false;
      if (exitReason === 'iterator_done' && !hadNonSystemEvent && hasConnections && !stopRecently) {
        void logClaudeDebugTail(session.threadId, 'early_exit_iterator_done');
        if (session.earlyExitRetries < 1 && session.lastUserMessage) {
          session.earlyExitRetries += 1;
          const retryContent = session.lastUserMessage;
          log('[ws-server]', 'early_exit_retry', {
            threadId: session.threadId,
            queryId: eventLoopQueryId,
            retryCount: session.earlyExitRetries,
            lastUserMessageLength: retryContent?.length || 0,
            queueLength: session.inputQueue.length,
            queueClosed: session.inputQueue.isClosed,
          });
          setTimeout(() => {
            if (session.activeQuery || session.inputQueue.length > 0) {
              return;
            }
            void (async () => {
              // Create fresh input queue for retry (old one may be closed)
              session.inputQueue = new MessageQueue();
              await initSession(session);
              startEventLoop(session);
              session.inputQueue.enqueue(retryContent);
            })();
          }, 200);
        }
      }
    }
  })();
}

/**
 * Format author prefix for message attribution.
 * Format: [Name (email)]: or [email]: if no name
 */
function formatAuthorPrefix(userName, userEmail) {
  if (userName && userEmail) {
    return `[${userName} (${userEmail})]: `;
  } else if (userName) {
    return `[${userName}]: `;
  } else if (userEmail) {
    return `[${userEmail}]: `;
  }
  return '';
}

// Handle a user message
async function handleUserMessage(session, content, userInfo = null) {
  // Prepend author attribution to message content
  const authorPrefix = formatAuthorPrefix(userInfo?.userName, userInfo?.userEmail);
  const attributedContent = authorPrefix + content;
  session.lastUserMessage = attributedContent;

  void writeTrace(session.threadId, { direction: 'ws_in', type: 'message', content: attributedContent, author: userInfo });
  log('[ws-server]', 'handleUserMessage', {
    threadId: session.threadId,
    contentLength: attributedContent.length,
    hasActiveQuery: Boolean(session.activeQuery),
    hasIterator: Boolean(session.queryIterator),
    queueLength: session.inputQueue.length,
    queueClosed: session.inputQueue.isClosed,
  });
  const shouldPrequeue = PREQUEUE_FIRST_MESSAGE && !session.activeQuery && !session.initPromise && session.inputQueue.length === 0;
  if (shouldPrequeue) {
    session.inputQueue.enqueue(attributedContent);
    log('[ws-server]', 'message_prequeued', {
      threadId: session.threadId,
      queueLength: session.inputQueue.length,
    });
  }

  // Initialize session if needed
  await initSession(session);

  // Start event loop if not running (it runs continuously)
  startEventLoop(session);

  if (!shouldPrequeue) {
    // Feed message to the MessageQueue
    // Messages are persisted by Claude SDK in ~/.claude/projects/.../session.jsonl
    session.inputQueue.enqueue(attributedContent);
  }
  log('[ws-server]', 'handleUserMessage_enqueued', {
    threadId: session.threadId,
    queueLength: session.inputQueue.length,
  });
}

// Bun WebSocket server with HTTP health endpoint
Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', version: VERSION }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Broadcast endpoint - receives messages from DO to forward to connected client(s)
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      try {
        const data = await req.json();
        let sent = false;
        for (const session of sessions.values()) {
          if (!session.attachedSockets) continue;
          for (const socket of session.attachedSockets) {
            socket.send(JSON.stringify(data));
            sent = true;
          }
        }
        if (sent) {
          return new Response('ok', { status: 200 });
        }
        return new Response('No active WebSocket connection', { status: 503 });
      } catch (e) {
        return new Response(String(e), { status: 400 });
      }
    }

    // Update integration env vars - pushed by worker when integrations change
    if (url.pathname === '/update-env' && req.method === 'POST') {
      try {
        const data = await req.json();
        if (data.env && typeof data.env === 'object') {
          integrationEnvVars = data.env;
          return new Response(JSON.stringify({ success: true, keys: Object.keys(integrationEnvVars) }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
        return new Response(JSON.stringify({ success: false, error: 'Missing env object' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (e) {
        return new Response(JSON.stringify({ success: false, error: String(e) }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // WebSocket upgrade
    if (req.headers.get('upgrade') === 'websocket') {
      // Extract per-thread deploy token from header (minted by worker during upgrade)
      // This token stores {orgId, threadId} for auto-preview after deploys
      const threadDeployToken = req.headers.get('x-chiridion-thread-deploy-token');
      // Extract user info headers for personalization
      const userName = req.headers.get('x-chiridion-user-name');
      const userEmail = req.headers.get('x-chiridion-user-email');

      const success = server.upgrade(req, {
        data: { threadDeployToken, userName, userEmail },
      });
      if (success) {
        return undefined; // Bun handles the upgrade
      }
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      totalConnections++;
      log('[ws-server]', 'ws_open', { totalConnections });
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(message);

        if (data.type === 'init') {
          // Get or generate threadId
          const threadId = typeof data.threadId === 'string' ? data.threadId.trim() : '';
          if (!threadId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Missing threadId - init requires a valid threadId' }));
            ws.close(1008, 'missing threadId');
            return;
          }

          // Get per-thread deploy token and user info from WebSocket upgrade (set by worker)
          const threadDeployToken = ws.data?.threadDeployToken || null;
          const userInfo = {
            userName: ws.data?.userName || null,
            userEmail: ws.data?.userEmail || null,
          };

          const session = getOrCreateSession(threadId, threadDeployToken, userInfo);
          void writeTrace(session.threadId, { direction: 'ws_in', type: 'init', payload: { threadId, lastEventId: data.lastEventId, hasDeployToken: !!threadDeployToken, userName: userInfo.userName } });
          log('[ws-server]', 'init', {
            threadId,
            lastEventId: data.lastEventId,
            hasDeployToken: Boolean(threadDeployToken),
            userName: userInfo.userName,
          });
          attachSession(ws, session, data.lastEventId);

        } else if (data.type === 'message') {
          // Get session from ws.data (set during init)
          const threadId = ws.data?.threadId || data.threadId;
          if (!threadId || !sessions.has(threadId)) {
            ws.send(JSON.stringify({ type: 'error', error: 'No session - send init first' }));
            return;
          }
          const session = sessions.get(threadId);
          // Get user info from the socket (set during WebSocket upgrade)
          const userInfo = {
            userName: ws.data?.userName || null,
            userEmail: ws.data?.userEmail || null,
          };
          log('[ws-server]', 'message', {
            threadId,
            contentLength: typeof data.content === 'string' ? data.content.length : null,
            hasSession: Boolean(session),
          });
          await handleUserMessage(session, data.content, userInfo);

        } else if (data.type === 'stop') {
          const threadId = ws.data?.threadId;
          if (threadId && sessions.has(threadId)) {
            const session = sessions.get(threadId);
            void writeTrace(session.threadId, { direction: 'ws_in', type: 'stop' });
            log('[ws-server]', 'stop', { threadId });
            session.lastStopRequestedAt = Date.now();
            // Close input queue to signal message stream to end
            session.inputQueue.close();
            if (session.activeQuery) {
              try {
                await session.activeQuery.interrupt();
              } catch (e) {
                logError('[ws-server]', 'Interrupt error:', String(e));
              }
            }
          }
        }
      } catch (e) {
        logError('[ws-server]', 'Message handling error:', String(e));
        ws.send(JSON.stringify({ type: 'error', error: String(e) }));
      }
    },

    close(ws, code, reason) {
      const threadId = ws?.data?.threadId;
      if (threadId && sessions.has(threadId)) {
        const session = sessions.get(threadId);
        if (session.attachedSockets) {
          session.attachedSockets.delete(ws);
        }
      }
      log('[ws-server]', 'ws_close', { threadId, code, reason: String(reason || '') });
    },

    error(ws, error) {
      logError('[ws-server]', 'WebSocket error:', String(error));
    },
  },
});
