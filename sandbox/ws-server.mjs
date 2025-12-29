import { query } from '@anthropic-ai/claude-agent-sdk';

// Configuration from environment
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = 8080;

if (!ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY env var required');
  process.exit(1);
}

// State - initialize sessionId from env var for session resumption
let sessionId = process.env.RESUME_SESSION_ID || null;
if (sessionId) {
  console.error('[ws-server] Resuming Claude session:', sessionId);
}
let currentAbortController = null;

// Log to stdout for DO persistence (NDJSON format)
function logForPersistence(event) {
  console.log(JSON.stringify(event));
}

// Query options for Claude SDK
function getQueryOptions(resumeSessionId) {
  const options = {
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    systemPrompt: { type: 'preset', preset: 'claude_code' },
    settingSources: ['project', 'user'],
  };

  if (resumeSessionId) {
    options.resume = resumeSessionId;
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

// Handle a user message - query Claude SDK and stream events
async function handleUserMessage(ws, content) {
  // Create abort controller for stop functionality
  currentAbortController = new AbortController();

  try {
    const options = getQueryOptions(sessionId);

    for await (const event of query({ prompt: content, options })) {
      // Check if aborted
      if (currentAbortController.signal.aborted) {
        ws.send(JSON.stringify({ type: 'stopped' }));
        break;
      }

      // Send event to client via WebSocket
      ws.send(JSON.stringify({ type: 'sdk_event', event }));

      // Capture session ID from init event
      if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
        if (!sessionId) {
          sessionId = event.session_id;
          logForPersistence({ type: 'session_id', sessionId: event.session_id });
        }
      }

      // Persist user messages (original prompt + tool results)
      if (event.type === 'user' && event.message) {
        const msgContent = contentToString(event.message.content);
        if (msgContent) {
          logForPersistence({ type: 'user_message', content: msgContent });

          // Send confirmation to client
          ws.send(JSON.stringify({
            type: 'message',
            message: {
              id: event.uuid || `msg_${Date.now()}`,
              role: 'user',
              content: msgContent,
              created_at: Date.now(),
            }
          }));
        }
      }

      // Persist assistant messages (full response with all content blocks)
      if (event.type === 'assistant' && event.message?.content) {
        const msgContent = contentToString(event.message.content);
        if (msgContent) {
          logForPersistence({ type: 'assistant_message', content: msgContent });

          // Send confirmation to client
          ws.send(JSON.stringify({
            type: 'message',
            message: {
              id: event.uuid || `msg_${Date.now()}`,
              role: 'assistant',
              content: msgContent,
              created_at: Date.now(),
            }
          }));
        }
      }
    }

  } catch (e) {
    const errorMsg = String(e);
    ws.send(JSON.stringify({ type: 'error', error: errorMsg }));
    logForPersistence({ type: 'error', error: errorMsg });
  } finally {
    currentAbortController = null;
  }
}

// Track active WebSocket connection for broadcasting
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
          if (currentAbortController) {
            currentAbortController.abort();
          }
        }
      } catch (e) {
        console.error('[ws-server] Message handling error:', e);
        ws.send(JSON.stringify({ type: 'error', error: String(e) }));
      }
    },

    close(ws) {
      console.error('[ws-server] WebSocket closed, waiting for new connection');
      activeWs = null;
      // Keep server running to accept new connections
      // R2 sync happens when container shuts down (run-ws-server.sh EXIT trap)
    },

    error(ws, error) {
      console.error('[ws-server] WebSocket error:', error);
    },
  },
});

console.error(`[ws-server] Listening on port ${PORT}`);
