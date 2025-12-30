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

// State
let sessionId = process.env.RESUME_SESSION_ID || null;
let activeQuery = null;
let messageResolver = null;
let queryIterator = null;
let messageQueue = []; // Queue for messages arriving before resolver is ready

if (sessionId) {
  console.error('[ws-server] Will resume Claude session:', sessionId);
}

// Log for DO persistence (NDJSON format)
// Use stderr with a special prefix that DO can parse
// Note: stdout may not be captured correctly in Cloudflare Container environments
const PERSIST_PREFIX = '[PERSIST]';
function logForPersistence(event) {
  const line = JSON.stringify(event);
  console.error(`${PERSIST_PREFIX}${line}`);
}

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
function getQueryOptions() {
  const options = {
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user'],
  };

  if (sessionId) {
    options.resume = sessionId;
  }

  return options;
}

// Async generator that yields user messages on demand
async function* createMessageStream() {
  while (true) {
    // Check queue first for any buffered messages
    let message;
    if (messageQueue.length > 0) {
      message = messageQueue.shift();
    } else {
      // Wait for next message
      message = await new Promise((resolve) => {
        messageResolver = resolve;
      });
    }

    if (message === null) {
      // Signal to stop
      return;
    }

    // Yield the user message
    yield {
      type: 'user',
      session_id: sessionId || '',
      message: {
        role: 'user',
        content: [{ type: 'text', text: message }],
      },
      parent_tool_use_id: null,
    };
  }
}

// Initialize the stateful query session
let eventLoopRunning = false;

function initSession() {
  if (activeQuery) return;

  console.error('[ws-server] Initializing stateful session');
  const options = getQueryOptions();
  const messageStream = createMessageStream();

  activeQuery = query({ prompt: messageStream, options });
  queryIterator = activeQuery[Symbol.asyncIterator]();
}

// Start continuous event loop - runs until query ends or error
function startEventLoop(ws) {
  if (eventLoopRunning || !queryIterator) return;
  eventLoopRunning = true;

  (async () => {
    try {
      while (true) {
        const { value: event, done } = await queryIterator.next();

        if (done) {
          console.error('[ws-server] Query completed');
          break;
        }

        // Send event to client via WebSocket
        ws.send(JSON.stringify({ type: 'sdk_event', event }));

        // Capture session ID from init event
        if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
          if (!sessionId) {
            sessionId = event.session_id;
            logForPersistence({ type: 'session_id', sessionId: event.session_id });
            console.error('[ws-server] Got session ID:', sessionId);
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
      console.error('[ws-server] Query error:', errorMsg);
      ws.send(JSON.stringify({ type: 'error', error: errorMsg }));
      logForPersistence({ type: 'error', error: errorMsg });
    } finally {
      activeQuery = null;
      queryIterator = null;
      eventLoopRunning = false;
    }
  })();
}

// Handle a user message
function handleUserMessage(ws, content) {
  // Log user message for DB persistence with timestamp-based ID
  const msgId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logForPersistence({ type: 'user_message', id: msgId, content });

  // Initialize session if needed
  initSession();

  // Start event loop if not running (it runs continuously)
  startEventLoop(ws);

  // Feed message to the generator
  if (messageResolver) {
    const resolver = messageResolver;
    messageResolver = null;
    resolver(content);
  } else {
    // Queue message - will be picked up when generator pulls
    messageQueue.push(content);
  }
}

// Track active WebSocket connection
let activeWs = null;

// Bun WebSocket server with HTTP health endpoint
Bun.serve({
  port: PORT,

  async fetch(req, server) {
    const url = new URL(req.url);

    // Health check endpoint
    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    // Broadcast endpoint - receives messages from DO to forward to connected client
    if (url.pathname === '/broadcast' && req.method === 'POST') {
      try {
        const data = await req.json();
        if (activeWs) {
          activeWs.send(JSON.stringify(data));
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
      activeWs = ws;
    },

    async message(ws, message) {
      console.error('[ws-server] Received message:', String(message).substring(0, 100));
      try {
        const data = JSON.parse(message);

        if (data.type === 'init') {
          // Resume session if provided
          if (data.sessionId) {
            sessionId = data.sessionId;
          }
          ws.send(JSON.stringify({ type: 'ready' }));

        } else if (data.type === 'message') {
          handleUserMessage(ws, data.content);

        } else if (data.type === 'stop') {
          // Interrupt the query if running
          if (activeQuery) {
            try {
              await activeQuery.interrupt();
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
      activeWs = null;

      // Signal message stream to stop
      if (messageResolver) {
        messageResolver(null);
        messageResolver = null;
      }

      // Clear message queue
      messageQueue = [];

      // Clean up query
      activeQuery = null;
      queryIterator = null;
    },

    error(ws, error) {
      console.error('[ws-server] WebSocket error:', error);
    },
  },
});

console.error(`[ws-server] Listening on port ${PORT}`);
