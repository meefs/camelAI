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
let accumulatedContent = []; // Accumulate full content blocks for persistence

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

// Generate a stable hash-based ID for content deduplication
// Uses first 16 chars of content + simple hash to create reproducible IDs
function generateContentId(prefix, content) {
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  // Simple hash function (djb2)
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  const hashStr = Math.abs(hash).toString(36);
  return `${prefix}_${hashStr}`;
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
    // Track state for current turn
    let assistantMessageId = null;

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

        // Handle stream_event wrapper (this is what we actually receive from the SDK)
        if (event.type === 'stream_event' && event.event) {
          const streamEvent = event.event;

          // Track content block starts - add new block to accumulated content
          if (streamEvent.type === 'content_block_start' && streamEvent.content_block) {
            const block = streamEvent.content_block;
            if (block.type === 'text') {
              accumulatedContent.push({ type: 'text', text: '' });
            } else if (block.type === 'tool_use') {
              accumulatedContent.push({
                type: 'tool_use',
                id: block.id,
                name: block.name,
                input: {},
                _inputJson: ''
              });
            } else if (block.type === 'thinking') {
              accumulatedContent.push({ type: 'thinking', thinking: '' });
            }
          }

          // Accumulate content from delta events
          if (streamEvent.type === 'content_block_delta' && streamEvent.delta) {
            const lastBlock = accumulatedContent[accumulatedContent.length - 1];
            if (streamEvent.delta.type === 'text_delta' && streamEvent.delta.text && lastBlock?.type === 'text') {
              lastBlock.text += streamEvent.delta.text;
            } else if (streamEvent.delta.type === 'input_json_delta' && streamEvent.delta.partial_json && lastBlock?.type === 'tool_use') {
              lastBlock._inputJson = (lastBlock._inputJson || '') + streamEvent.delta.partial_json;
            } else if (streamEvent.delta.type === 'thinking_delta' && streamEvent.delta.thinking && lastBlock?.type === 'thinking') {
              lastBlock.thinking += streamEvent.delta.thinking;
            }
          }

          // Turn complete when we see message_delta with stop_reason
          // Don't persist here - wait for assistant event which has stable message ID
          if (streamEvent.type === 'message_delta' && streamEvent.delta?.stop_reason) {
            if (accumulatedContent.length > 0) {
              // Finalize tool_use input JSON for the accumulated content
              accumulatedContent = accumulatedContent.map(block => {
                if (block.type === 'tool_use' && block._inputJson) {
                  try {
                    block.input = JSON.parse(block._inputJson);
                  } catch (e) {
                    block.input = { _raw: block._inputJson };
                  }
                  delete block._inputJson;
                }
                return block;
              });
            }
            // Don't reset or persist yet - wait for assistant event with stable ID
            syncWorkspace();
          }
        }

        // Persist from assistant event which has stable API message ID
        if (event.type === 'assistant' && event.message) {
          // Use full content from assistant event (more reliable than streaming accumulation)
          if (event.message.content && event.message.content.length > 0) {
            accumulatedContent = [...event.message.content];
          }
          // Stable message ID from Anthropic API (e.g., msg_01ABC...)
          assistantMessageId = event.message.id || null;

          // Turn complete - persist with stable ID
          if (event.message.stop_reason) {
            if (accumulatedContent.length > 0 && assistantMessageId) {
              const contentJson = JSON.stringify(accumulatedContent);
              logForPersistence({ type: 'assistant_message', id: assistantMessageId, content: contentJson });
            }
            accumulatedContent = [];
            assistantMessageId = null;
          }
        }

        // Persist tool results (these come from SDK as user messages)
        if (event.type === 'user' && event.message?.content) {
          // Tool results don't need separate persistence - they're part of the SDK state
        }

        // Result means query is complete (end of session)
        if (event.type === 'result') {
          if (accumulatedContent.length > 0) {
            const contentJson = JSON.stringify(accumulatedContent);
            const msgId = assistantMessageId || generateContentId('asst', contentJson);
            logForPersistence({ type: 'assistant_message', id: msgId, content: contentJson });
          } else if (event.result && typeof event.result === 'string') {
            const msgId = generateContentId('asst', event.result);
            logForPersistence({ type: 'assistant_message', id: msgId, content: event.result });
          }
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
      accumulatedContent = [];
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

      // Clear message queue and accumulated content
      messageQueue = [];
      accumulatedContent = [];

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
