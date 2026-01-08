import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { appendFile, mkdir } from 'fs/promises';

// Version for verifying container has latest code
const VERSION = '2026-01-01-sandbox-v7';

// Configuration from environment
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const WORKER_BASE_URL = process.env.WORKER_BASE_URL;
const PORT = 8080;
const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
const TRACE_EVENTS = process.env.CHIRIDION_TRACE_EVENTS !== '0';
const TRACE_DIR = `${SYNC_DIR}/.chiridion/trace`;
const TRACE_ALL_FILE = `${TRACE_DIR}/_all.ndjson`;

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

// Session state - keyed by threadId
const sessions = new Map();
const MAX_EVENT_BUFFER = 500;
let traceDirPromise = null;

function sanitizeFileSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function ensureTraceDir() {
  if (!traceDirPromise) {
    traceDirPromise = mkdir(TRACE_DIR, { recursive: true }).catch((err) => {
      console.error('[ws-server] Failed to create trace dir:', err?.message || String(err));
    });
  }
  return traceDirPromise;
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
    console.error('[ws-server] Trace write failed:', error?.message || String(error));
  }
}

function createSession(threadId, threadDeployToken = null) {
  const session = {
    threadId,
    threadDeployToken, // Per-thread token for auto-preview after deploys
    activeQuery: null,
    queryIterator: null,
    eventLoopRunning: false,
    messageResolver: null,
    messageQueue: [],
    attachedSockets: new Set(),
    eventBuffer: [],
    nextEventId: 1,
  };
  sessions.set(threadId, session);
  return session;
}

function getOrCreateSession(threadId, threadDeployToken = null) {
  if (!threadId) {
    threadId = crypto.randomUUID();
  }
  if (sessions.has(threadId)) {
    const session = sessions.get(threadId);
    // Update token if provided (new connection for existing session)
    if (threadDeployToken && !session.threadDeployToken) {
      session.threadDeployToken = threadDeployToken;
    }
    return session;
  }
  return createSession(threadId, threadDeployToken);
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
  console.error('[ws-server] Uncaught exception:', summarizeError(error));
});

process.on('unhandledRejection', (error) => {
  console.error('[ws-server] Unhandled rejection:', summarizeError(error));
});

process.on('exit', () => {});
process.on('SIGTERM', () => {});

// Sync workspace to R2 after each turn (async, non-blocking)
let syncInProgress = false;
function syncWorkspace() {
  if (syncInProgress) return;
  syncInProgress = true;
  const proc = spawn('node', ['/app/sync.mjs', 'upload', SYNC_DIR], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('close', (code) => {
    syncInProgress = false;
    if (code !== 0) {
      console.error('[ws-server] Sync failed:', code);
    }
  });
  proc.on('error', (err) => {
    syncInProgress = false;
    console.error('[ws-server] Sync error:', err.message);
  });
}

// Check if a session JSONL file exists
function sessionFileExists(sessionId) {
  if (!sessionId) return false;
  const projectPath = '-home-claude';
  const jsonlPath = `${SYNC_DIR}/.claude/projects/${projectPath}/${sessionId}.jsonl`;
  return existsSync(jsonlPath);
}

// Query options for Claude SDK
function getQueryOptions(session) {
  // Build env vars, using per-thread deploy token if available
  // This replaces the container's org-level token with a thread-specific one
  // that includes threadId for auto-preview after deploys
  const envVars = {
    ...process.env,
    THREAD_ID: session.threadId || '',
  };

  // Use per-thread deploy token if available (preferred for auto-preview)
  // Falls back to container's org-level token if not available
  if (session.threadDeployToken) {
    envVars.CLOUDFLARE_API_TOKEN = session.threadDeployToken;
  }

  const options = {
    model: 'opus',
    fallbackModel: 'sonnet',
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
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
        console.error('[ws-server] Failed to send event:', e);
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
        console.error('[ws-server] Failed to replay event:', e);
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
  ws.data = { threadId: session.threadId };

  // Send the threadId to the client - they may have provided it or we generated it
  if (session.threadId) {
    ws.send(JSON.stringify({ type: 'session', sessionId: session.threadId }));
  }

  ws.send(JSON.stringify({ type: 'ready' }));
  replayBufferedEvents(session, ws, lastEventId);
}

// Initialize the stateful query session
function initSession(session) {
  if (session.activeQuery) return;

  try {
    const options = getQueryOptions(session);
    const messageStream = createMessageStream(session);

    session.activeQuery = query({ prompt: messageStream, options });
    session.queryIterator = session.activeQuery[Symbol.asyncIterator]();
  } catch (error) {
    console.error('[ws-server] Failed to init:', summarizeError(error));
    bufferEvent(session, { type: 'error', error: `Failed to initialize session: ${String(error)}` });
  }
}

// Start continuous event loop - runs until query ends or error
function startEventLoop(session) {
  if (session.eventLoopRunning || !session.queryIterator) return;
  session.eventLoopRunning = true;

  (async () => {
    try {
      while (true) {
        const { value: event, done } = await session.queryIterator.next();

        if (done) {
          break;
        }

        // Send event to client via WebSocket (or buffer if detached)
        bufferEvent(session, { type: 'sdk_event', event });

        // Sync workspace when turn completes (message_delta with stop_reason)
        if (event.type === 'stream_event' && event.event?.type === 'message_delta' && event.event.delta?.stop_reason) {
          syncWorkspace();
        }

        // Result means this turn is done - but keep loop alive if sockets connected or messages pending
        if (event.type === 'result') {
          const hasConnections = session.attachedSockets && session.attachedSockets.size > 0;
          const hasPendingMessages = session.messageQueue.length > 0;
          if (!hasConnections && !hasPendingMessages) {
            break;
          }
          // Continue looping - generator will yield queued message or wait for new one
        }
      }
    } catch (e) {
      console.error('[ws-server] Query error:', summarizeError(e));
      bufferEvent(session, { type: 'error', error: String(e) });
      void writeTrace(session.threadId, { direction: 'error', error: String(e) });
      logForPersistence({ type: 'error', error: String(e) });
      syncWorkspace();
    } finally {
      session.activeQuery = null;
      session.queryIterator = null;
      session.eventLoopRunning = false;
    }
  })();
}

// Handle a user message
function handleUserMessage(session, content) {
  void writeTrace(session.threadId, { direction: 'ws_in', type: 'message', content });
  // Initialize session if needed
  initSession(session);

  // Start event loop if not running (it runs continuously)
  startEventLoop(session);

  // Feed message to the generator
  // Messages are persisted by Claude SDK in ~/.claude/projects/.../session.jsonl
  if (session.messageResolver) {
    const resolver = session.messageResolver;
    session.messageResolver = null;
    resolver(content);
  } else {
    // Queue message - will be picked up when generator pulls
    session.messageQueue.push(content);
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

    // WebSocket upgrade
    if (req.headers.get('upgrade') === 'websocket') {
      // Extract per-thread deploy token from header (minted by worker during upgrade)
      // This token stores {orgId, threadId} for auto-preview after deploys
      const threadDeployToken = req.headers.get('x-chiridion-thread-deploy-token');

      const success = server.upgrade(req, {
        data: { threadDeployToken },
      });
      if (success) {
        return undefined; // Bun handles the upgrade
      }
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {},

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

          // Get per-thread deploy token from WebSocket upgrade (set by worker)
          const threadDeployToken = ws.data?.threadDeployToken || null;

          const session = getOrCreateSession(threadId, threadDeployToken);
          void writeTrace(session.threadId, { direction: 'ws_in', type: 'init', payload: { threadId, lastEventId: data.lastEventId, hasDeployToken: !!threadDeployToken } });
          attachSession(ws, session, data.lastEventId);

        } else if (data.type === 'message') {
          // Get session from ws.data (set during init)
          const threadId = ws.data?.threadId || data.threadId;
          if (!threadId || !sessions.has(threadId)) {
            ws.send(JSON.stringify({ type: 'error', error: 'No session - send init first' }));
            return;
          }
          const session = sessions.get(threadId);
          handleUserMessage(session, data.content);

        } else if (data.type === 'stop') {
          const threadId = ws.data?.threadId;
          if (threadId && sessions.has(threadId)) {
            const session = sessions.get(threadId);
            void writeTrace(session.threadId, { direction: 'ws_in', type: 'stop' });
            if (session.activeQuery) {
              try {
                await session.activeQuery.interrupt();
              } catch (e) {
                console.error('[ws-server] Interrupt error:', e);
              }
            }
          }
        }
      } catch (e) {
        console.error('[ws-server] Message handling error:', e);
        ws.send(JSON.stringify({ type: 'error', error: String(e) }));
      }
    },

    close(ws, code, reason) {
      const threadId = ws?.data?.threadId;
      console.log('[ws-server] WebSocket closed', {
        threadId,
        code,
        reason: typeof reason === 'string' ? reason : reason?.toString?.(),
      });
      if (threadId && sessions.has(threadId)) {
        const session = sessions.get(threadId);
        if (session.attachedSockets) {
          session.attachedSockets.delete(ws);
        }
      }
    },

    error(ws, error) {
      console.error('[ws-server] WebSocket error:', error);
    },
  },
});
