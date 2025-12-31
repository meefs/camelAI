import { query } from '@anthropic-ai/claude-agent-sdk';
import { spawn } from 'child_process';

// Configuration from environment
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = 8080;
const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

// Session state
const sessions = new Map();
const MAX_EVENT_BUFFER = 500;
let lastSessionId = null;

function createSession(id) {
  const session = {
    id,
    claudeSessionId: null,
    activeQuery: null,
    queryIterator: null,
    eventLoopRunning: false,
    messageResolver: null,
    messageQueue: [],
    attachedWs: null,
    eventBuffer: [],
    nextEventId: 1,
    lastEventSummary: null,
    lastEventAt: null,
  };
  sessions.set(id, session);
  lastSessionId = id;
  return session;
}

function getOrCreateSession(id) {
  if (id && sessions.has(id)) return sessions.get(id);
  if (id && !sessions.has(id)) return createSession(id);
  if (lastSessionId && sessions.has(lastSessionId)) return sessions.get(lastSessionId);
  const newId = crypto.randomUUID();
  return createSession(newId);
}

function resolveSessionFromMessage(ws, data) {
  if (data?.sessionId) return getOrCreateSession(data.sessionId);
  const wsSessionId = ws?.data?.sessionId;
  if (wsSessionId && sessions.has(wsSessionId)) return sessions.get(wsSessionId);
  return getOrCreateSession(null);
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

process.on('exit', (code) => {
  console.error('[ws-server] Process exit:', code);
});

process.on('SIGTERM', () => {
  console.error('[ws-server] Received SIGTERM');
});

// Sync workspace to R2 after each turn (async, non-blocking)
let syncInProgress = false;
function syncWorkspace() {
  if (syncInProgress) {
    console.error('[ws-server] Sync already in progress, skipping');
    return;
  }
  syncInProgress = true;
  console.error('[ws-server] Starting workspace sync...');
  const proc = spawn('node', ['/app/sync.mjs', 'upload', SYNC_DIR], {
    stdio: ['ignore', 'inherit', 'inherit'],
  });
  proc.on('close', (code) => {
    syncInProgress = false;
    if (code === 0) {
      console.error('[ws-server] Workspace sync complete');
    } else {
      console.error(`[ws-server] Workspace sync failed with code ${code}`);
    }
  });
  proc.on('error', (err) => {
    syncInProgress = false;
    console.error('[ws-server] Workspace sync error:', err.message);
  });
}

// Query options for Claude SDK
function getQueryOptions(session) {
  const options = {
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user'],
  };

  if (session.claudeSessionId) {
    options.resume = session.claudeSessionId;
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
      session_id: session.claudeSessionId || '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
      parent_tool_use_id: null,
    };
  }
}

function bufferEvent(session, payload) {
  const eventId = session.nextEventId++;
  const envelope = { ...payload, eventId, sessionId: session.id };
  session.eventBuffer.push(envelope);
  if (session.eventBuffer.length > MAX_EVENT_BUFFER) {
    session.eventBuffer.shift();
  }
  if (session.attachedWs) {
    try {
      session.attachedWs.send(JSON.stringify(envelope));
    } catch (e) {
      console.error('[ws-server] Failed to send event:', e);
      session.attachedWs = null;
    }
  }
  return envelope;
}

function replayBufferedEvents(session, ws, lastEventId) {
  const fromId = Number.isFinite(lastEventId) ? lastEventId : 0;
  for (const envelope of session.eventBuffer) {
    if (envelope.eventId > fromId) {
      try {
        ws.send(JSON.stringify(envelope));
      } catch (e) {
        console.error('[ws-server] Failed to replay event:', e);
        break;
      }
    }
  }
}

function attachSession(ws, session, lastEventId) {
  if (session.attachedWs && session.attachedWs !== ws) {
    try {
      session.attachedWs.close(1000, 'replaced');
    } catch {
      // ignore
    }
  }
  session.attachedWs = ws;
  ws.data = { sessionId: session.id };
  ws.send(JSON.stringify({ type: 'session', sessionId: session.id }));
  ws.send(JSON.stringify({ type: 'ready' }));
  replayBufferedEvents(session, ws, lastEventId);
}

// Initialize the stateful query session
function initSession(session) {
  if (session.activeQuery) return;

  console.error('[ws-server] Initializing stateful session', session.id);
  try {
    const options = getQueryOptions(session);
    const messageStream = createMessageStream(session);

    session.activeQuery = query({ prompt: messageStream, options });
    session.queryIterator = session.activeQuery[Symbol.asyncIterator]();
  } catch (error) {
    console.error('[ws-server] Failed to initialize session', {
      sessionId: session.id,
      claudeSessionId: session.claudeSessionId,
      error: summarizeError(error),
    });
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
          console.error('[ws-server] Query completed');
          break;
        }

        session.lastEventSummary = {
          type: event.type,
          subtype: event.subtype,
          streamType: event.event?.type,
        };
        session.lastEventAt = Date.now();

        // Send event to client via WebSocket (or buffer if detached)
        bufferEvent(session, { type: 'sdk_event', event });

        // Capture session ID from init event
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          if (!session.claudeSessionId) {
            session.claudeSessionId = event.session_id;
            logForPersistence({ type: 'session_id', sessionId: event.session_id });
            console.error('[ws-server] Got session ID:', session.claudeSessionId);
          }
        }

        // Handle stream_event wrapper - sync workspace when turn completes
        if (event.type === 'stream_event' && event.event) {
          const streamEvent = event.event;
          if (streamEvent.type === 'message_delta' && streamEvent.delta?.stop_reason) {
            syncWorkspace();
          }
        }

        // Persist assistant messages (following SDK demo pattern - no stop_reason check)
        if (event.type === 'assistant' && event.message) {
          const messageId = event.message.id;
          const content = event.message.content;

          // Persist if we have content (content is always an array of blocks)
          if (messageId && Array.isArray(content) && content.length > 0) {
            const contentJson = JSON.stringify(content);
            logForPersistence({ type: 'assistant_message', id: messageId, content: contentJson });
            console.error('[ws-server] Persisted assistant message:', messageId);
          }
        }

        // Persist tool results (these come from SDK as user messages)
        if (event.type === 'user' && event.message?.content) {
          // Tool results don't need separate persistence - they're part of the SDK state
        }

        // Result means query is complete (end of session)
        if (event.type === 'result') {
          // Final result - sync and exit
          syncWorkspace();
          break;
        }
      }
    } catch (e) {
      const errorMsg = String(e);
      console.error('[ws-server] Query error:', {
        sessionId: session.id,
        claudeSessionId: session.claudeSessionId,
        lastEvent: session.lastEventSummary,
        lastEventAt: session.lastEventAt,
        error: summarizeError(e),
      });
      bufferEvent(session, { type: 'error', error: errorMsg });
      logForPersistence({ type: 'error', error: errorMsg });
    } finally {
      session.activeQuery = null;
      session.queryIterator = null;
      session.eventLoopRunning = false;
    }
  })();
}

// Handle a user message
function handleUserMessage(session, content) {
  // Log user message for DB persistence with timestamp-based ID
  const msgId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logForPersistence({ type: 'user_message', id: msgId, content });

  // Initialize session if needed
  initSession(session);

  // Start event loop if not running (it runs continuously)
  startEventLoop(session);

  // Feed message to the generator
  if (session.messageResolver) {
    const resolver = session.messageResolver;
    session.messageResolver = null;
    resolver(content);
  } else {
    // Queue message - will be picked up when generator pulls
    session.messageQueue.push(content);
  }
}

// Resume default session if provided by env (single-session compatibility)
if (process.env.RESUME_SESSION_ID) {
  const resumed = createSession(crypto.randomUUID());
  resumed.claudeSessionId = process.env.RESUME_SESSION_ID;
  console.error('[ws-server] Will resume Claude session:', resumed.claudeSessionId);
}

// Bun WebSocket server with HTTP health endpoint
Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // Broadcast endpoint - receives messages from DO to forward to connected client(s)
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      try {
        const data = await req.json();
        let sent = false;
        for (const session of sessions.values()) {
          if (session.attachedWs) {
            session.attachedWs.send(JSON.stringify(data));
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
      const success = server.upgrade(req);
      if (success) {
        return undefined; // Bun handles the upgrade
      }
      return new Response('WebSocket upgrade failed', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      console.error('[ws-server] WebSocket connection opened');
    },

    async message(ws, message) {
      console.error('[ws-server] Received message:', String(message).substring(0, 100));
      try {
        const data = JSON.parse(message);

        if (data.type === 'init') {
          const session = resolveSessionFromMessage(ws, data);
          attachSession(ws, session, data.lastEventId);

        } else if (data.type === 'message') {
          const session = resolveSessionFromMessage(ws, data);
          handleUserMessage(session, data.content);

        } else if (data.type === 'stop') {
          const session = resolveSessionFromMessage(ws, data);
          if (session.activeQuery) {
            try {
              await session.activeQuery.interrupt();
            } catch (e) {
              console.error('[ws-server] Interrupt error:', e);
            }
          }
        }
      } catch (e) {
        console.error('[ws-server] Message handling error:', e);
        ws.send(JSON.stringify({ type: 'error', error: String(e) }));
      }
    },

    close(ws) {
      console.error('[ws-server] WebSocket closed');
      const sessionId = ws?.data?.sessionId;
      if (sessionId && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);
        if (session.attachedWs === ws) {
          session.attachedWs = null;
        }
      }
    },

    error(ws, error) {
      console.error('[ws-server] WebSocket error:', error);
    },
  },
});

console.error(`[ws-server] Listening on port ${PORT}`);
