import { unstable_v2_createSession, unstable_v2_resumeSession } from '@anthropic-ai/claude-agent-sdk';
import { appendFile, mkdir, access } from 'fs/promises';

// Version for verifying container has latest code
const VERSION = '2026-01-23-sandbox-v28-sdk-v2-api';

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
    // V2 API: uses sdkSession + streamIterator instead of activeQuery + queryIterator + inputQueue
    sdkSession: null,
    streamIterator: null,
    initPromise: null,
    queryId: 0,
    earlyExitRetries: 0,
    lastUserMessage: null,
    lastStopRequestedAt: 0,
    eventLoopRunning: false,
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

// Session options for Claude SDK V2 API
// Note: V2 has fewer options than V1 - missing: includePartialMessages, mcpServers, stderr, systemPrompt
// Resume is handled via separate unstable_v2_resumeSession function
function getSessionOptions(session) {
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

  // V2 API options
  // V2 supports: model, permissionMode, env, allowedTools, disallowedTools, canUseTool, hooks, executable
  // V2 missing: includePartialMessages, mcpServers, stderr, systemPrompt, settingSources, agents, fallbackModel, cwd
  const options = {
    model: 'opus',
    permissionMode: 'bypassPermissions',
    env: envVars,
  };

  return options;
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

// Initialize the stateful SDK session using V2 API
async function initSession(session) {
  if (session.sdkSession) {
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
      const fileExists = await sessionFileExists(session.threadId);
      const options = getSessionOptions(session);

      // V2 API: use resumeSession if session file exists, otherwise createSession
      if (fileExists && session.threadId) {
        log('[ws-server]', 'initSession_resume', { threadId: session.threadId });
        session.sdkSession = unstable_v2_resumeSession(session.threadId, options);
      } else {
        log('[ws-server]', 'initSession_create', { threadId: session.threadId });
        session.sdkSession = unstable_v2_createSession(options);
      }

      // V2 API: get stream iterator - it stays open until close() is called
      session.streamIterator = session.sdkSession.stream();
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

// Start continuous event loop - runs until stream ends or error
// V2 API: stream stays open until close() is called, which should prevent early exits
function startEventLoop(session) {
  if (session.eventLoopRunning || !session.streamIterator) {
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
      // V2 API: iterate the stream - it won't end until close() is called
      for await (const event of session.streamIterator) {
        eventCount++;

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

        // Result means this turn is done - but keep loop alive if sockets connected
        if (eventType === 'result') {
          log('[ws-server]', 'sdk_result', {
            threadId: session.threadId,
            stopReason: event?.stop_reason || event?.message?.stop_reason || null,
            status: event?.status || event?.message?.status || null,
          });
          const hasConnections = session.attachedSockets && session.attachedSockets.size > 0;
          if (!hasConnections) {
            exitReason = 'no_connections';
            break;
          }
          // V2 API: stream stays open, will continue when send() is called
        }
      }
      exitReason = 'stream_ended';
    } catch (e) {
      exitReason = 'error';
      logError('[ws-server]', 'Query error:', summarizeError(e));
      bufferEvent(session, { type: 'error', error: String(e) });
      void writeTrace(session.threadId, { direction: 'error', error: String(e) });
      logForPersistence({ type: 'error', error: String(e) });
    } finally {
      session.sdkSession = null;
      session.streamIterator = null;
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

      // V2 API should not have early exits, but keep retry logic just in case
      const hasConnections = session.attachedSockets && session.attachedSockets.size > 0;
      const stopCooldownMs = 5000;
      const stopRecently = session.lastStopRequestedAt
        ? Date.now() - session.lastStopRequestedAt < stopCooldownMs
        : false;
      if (exitReason === 'stream_ended' && !hadNonSystemEvent && hasConnections && !stopRecently) {
        if (session.earlyExitRetries < 1 && session.lastUserMessage) {
          session.earlyExitRetries += 1;
          const retryContent = session.lastUserMessage;
          log('[ws-server]', 'early_exit_retry', {
            threadId: session.threadId,
            queryId: eventLoopQueryId,
            retryCount: session.earlyExitRetries,
          });
          setTimeout(() => {
            if (session.sdkSession) {
              return;
            }
            void (async () => {
              await initSession(session);
              startEventLoop(session);
              // V2 API: use send() to enqueue message
              if (session.sdkSession) {
                session.sdkSession.send({
                  type: 'user',
                  message: { role: 'user', content: retryContent },
                });
              }
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
    hasSession: Boolean(session.sdkSession),
    hasStream: Boolean(session.streamIterator),
  });

  // Initialize session if needed
  await initSession(session);

  // Start event loop if not running (it runs continuously)
  startEventLoop(session);

  // V2 API: use send() to enqueue message to the session
  // Messages are persisted by Claude SDK in ~/.claude/projects/.../session.jsonl
  if (session.sdkSession) {
    session.sdkSession.send({
      type: 'user',
      message: { role: 'user', content: attributedContent },
    });
    log('[ws-server]', 'handleUserMessage_sent', {
      threadId: session.threadId,
    });
  } else {
    logError('[ws-server]', 'handleUserMessage_no_session', { threadId: session.threadId });
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
            // V2 API: close() terminates the session and underlying process
            if (session.sdkSession) {
              try {
                session.sdkSession.close();
              } catch (e) {
                logError('[ws-server]', 'Close error:', String(e));
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
