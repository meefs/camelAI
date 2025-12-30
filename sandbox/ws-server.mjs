import { query } from '@anthropic-ai/claude-agent-sdk';

// Configuration from environment
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = 8080;

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

// Log to stdout for DO persistence (NDJSON format)
// Use Bun.write for synchronous, unbuffered writes
function logForPersistence(event) {
  const line = JSON.stringify(event) + '\n';
  Bun.write(Bun.stdout, line);
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

// Convert SDK message content to a string for persistence
function contentToString(content) {
  if (!content || !Array.isArray(content)) return '';

  const parts = [];
  for (const block of content) {
    if (block.type === 'text' && block.text) {
      parts.push(block.text);
    } else if (block.type === 'tool_use') {
      parts.push(`[Tool: ${block.name}]\n${JSON.stringify(block.input, null, 2)}`);
    } else if (block.type === 'tool_result') {
      const resultContent = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content);
      parts.push(`[Tool Result]\n${resultContent}`);
    }
  }
  return parts.join('\n\n');
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
function initSession() {
  if (activeQuery) return;

  console.error('[ws-server] Initializing stateful session');
  const options = getQueryOptions();
  const messageStream = createMessageStream();

  activeQuery = query({ prompt: messageStream, options });
  queryIterator = activeQuery[Symbol.asyncIterator]();
}

// Process events from the query until we need more user input
async function processEvents(ws) {
  if (!queryIterator) return;

  try {
    while (true) {
      const { value: event, done } = await queryIterator.next();

      if (done) {
        console.error('[ws-server] Query completed');
        activeQuery = null;
        queryIterator = null;
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

      // Persist tool results (user events) - but don't send as separate messages
      // Tool results are part of the assistant's turn, not standalone user messages
      if (event.type === 'user' && event.message) {
        const msgContent = contentToString(event.message.content);
        if (msgContent) {
          // Log for DB persistence only
          logForPersistence({ type: 'tool_result', content: msgContent });
        }
      }

      // Result means this turn is complete - persist the assistant message from result
      if (event.type === 'result') {
        if (event.result && typeof event.result === 'string') {
          // Use event UUID or generate timestamp-based ID for dedup
          const msgId = event.uuid || `asst_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          logForPersistence({ type: 'assistant_message', id: msgId, content: event.result });
        }
        break;
      }
    }
  } catch (e) {
    const errorMsg = String(e);
    console.error('[ws-server] Query error:', errorMsg);
    ws.send(JSON.stringify({ type: 'error', error: errorMsg }));
    logForPersistence({ type: 'error', error: errorMsg });

    // Reset session on error
    activeQuery = null;
    queryIterator = null;
  }
}

// Handle a user message
async function handleUserMessage(ws, content) {
  // Log user message for DB persistence with timestamp-based ID
  // This allows repeated identical messages while deduping log replays
  const msgId = `user_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  logForPersistence({ type: 'user_message', id: msgId, content });

  // Initialize session if needed
  initSession();

  // Send message to the query via the resolver, or queue if not ready yet
  if (messageResolver) {
    const resolver = messageResolver;
    messageResolver = null;
    resolver(content);
  } else {
    // Queue message - will be picked up when stream starts pulling
    messageQueue.push(content);
  }

  // Process events until turn is complete
  await processEvents(ws);
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
          console.error('[ws-server] Got init, sending ready');
          // Resume session if provided
          if (data.sessionId) {
            sessionId = data.sessionId;
          }
          // Send ready confirmation
          ws.send(JSON.stringify({ type: 'ready' }));
          console.error('[ws-server] Sent ready');

        } else if (data.type === 'message') {
          await handleUserMessage(ws, data.content);

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
