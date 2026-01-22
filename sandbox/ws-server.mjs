import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';

// Version for verifying container has latest code
const VERSION = '2026-01-22-sandbox-v21-fix-claude-dir-perms';

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
    eventLoopRunning: false,
    messageResolver: null,
    messageQueue: [],
    attachedSockets: new Set(),
    eventBuffer: [],
    nextEventId: 1,
    taskToolUseIds: new Set(),
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

// Check if a session JSONL file exists
function sessionFileExists(sessionId) {
  if (!sessionId) return false;
  const projectPath = '-home-claude';
  const jsonlPath = `${SYNC_DIR}/.claude/projects/${projectPath}/${sessionId}.jsonl`;
  return existsSync(jsonlPath);
}

// Query options for Claude SDK
function getQueryOptions(session) {
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
    // Check if session file exists to determine resume vs new
    if (sessionFileExists(session.threadId)) {
      options.resume = session.threadId;
    } else {
      options.extraArgs = { 'session-id': session.threadId };
    }
  }

  return options;
}

// Async generator that yields user messages on demand
async function* createMessageStream(session) {
  while (true) {
    // Check queue first for any buffered messages
    let message;
    if (session.messageQueue.length > 0) {
      message = session.messageQueue.shift();
    } else {
      // Wait for next message
      message = await new Promise((resolve) => {
        session.messageResolver = resolve;
      });
    }

    if (message === null) {
      // Signal to stop
      return;
    }

    // Yield the user message
    yield {
      type: 'user',
      session_id: session.threadId || '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
      parent_tool_use_id: null,
    };
  }
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
}

// Initialize the stateful query session
function initSession(session) {
  if (session.activeQuery) {
    return;
  }

  try {
    const options = getQueryOptions(session);
    const messageStream = createMessageStream(session);
    session.activeQuery = query({ prompt: messageStream, options });
    session.queryIterator = session.activeQuery[Symbol.asyncIterator]();
  } catch (error) {
    logError('[ws-server]', 'Failed to init:', summarizeError(error));
    bufferEvent(session, { type: 'error', error: `Failed to initialize session: ${String(error)}` });
  }
}

// Start continuous event loop - runs until query ends or error
function startEventLoop(session) {
  if (session.eventLoopRunning || !session.queryIterator) {
    return;
  }
  session.eventLoopRunning = true;

  (async () => {
    let exitReason = 'unknown';
    let eventCount = 0;
    try {
      while (true) {
        const { value: event, done } = await session.queryIterator.next();
        eventCount++;

        if (done) {
          exitReason = 'iterator_done';
          break;
        }

        // Send event to client via WebSocket (or buffer if detached)
        bufferEvent(session, { type: 'sdk_event', event });
        trackTaskToolUse(session, event);
        persistTaskResultUpdates(session, event);

        // Result means this turn is done - but keep loop alive if sockets connected or messages pending
        if (event.type === 'result') {
          const hasConnections = session.attachedSockets && session.attachedSockets.size > 0;
          const hasPendingMessages = session.messageQueue.length > 0;
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
function handleUserMessage(session, content, userInfo = null) {
  // Prepend author attribution to message content
  const authorPrefix = formatAuthorPrefix(userInfo?.userName, userInfo?.userEmail);
  const attributedContent = authorPrefix + content;

  void writeTrace(session.threadId, { direction: 'ws_in', type: 'message', content: attributedContent, author: userInfo });
  // Initialize session if needed
  initSession(session);

  // Start event loop if not running (it runs continuously)
  startEventLoop(session);

  // Feed message to the generator
  // Messages are persisted by Claude SDK in ~/.claude/projects/.../session.jsonl
  if (session.messageResolver) {
    const resolver = session.messageResolver;
    session.messageResolver = null;
    resolver(attributedContent);
  } else {
    // Queue message - will be picked up when generator pulls
    session.messageQueue.push(attributedContent);
  }
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
          handleUserMessage(session, data.content, userInfo);

        } else if (data.type === 'stop') {
          const threadId = ws.data?.threadId;
          if (threadId && sessions.has(threadId)) {
            const session = sessions.get(threadId);
            void writeTrace(session.threadId, { direction: 'ws_in', type: 'stop' });
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
    },

    error(ws, error) {
      logError('[ws-server]', 'WebSocket error:', String(error));
    },
  },
});
