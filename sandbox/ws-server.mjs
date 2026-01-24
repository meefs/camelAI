import { query } from '@anthropic-ai/claude-agent-sdk';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';

const VERSION = '2026-01-23-sdk-todo-persist-v1';
const PORT = 8080;
const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
const TODOS_DIR = `${SYNC_DIR}/.chiridion/todos`;

console.log(`[ws-server] Starting version=${VERSION} port=${PORT}`);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
}

// Simple async queue for feeding messages to SDK
class MessageQueue {
  #queue = [];
  #waiting = null;
  #closed = false;

  [Symbol.asyncIterator]() { return this; }

  next() {
    if (this.#queue.length > 0) {
      return Promise.resolve({ done: false, value: this.#queue.shift() });
    }
    if (this.#closed) {
      return Promise.resolve({ done: true });
    }
    return new Promise(resolve => { this.#waiting = resolve; });
  }

  enqueue(value) {
    if (this.#closed) return;
    if (this.#waiting) {
      const resolve = this.#waiting;
      this.#waiting = null;
      resolve({ done: false, value });
    } else {
      this.#queue.push(value);
    }
  }

  close() {
    this.#closed = true;
    if (this.#waiting) {
      this.#waiting({ done: true });
      this.#waiting = null;
    }
  }

  get length() { return this.#queue.length; }
}

// Todo state persistence - simple file per thread
let todosDirPromise = null;

function ensureTodosDir() {
  if (!todosDirPromise) {
    todosDirPromise = mkdir(TODOS_DIR, { recursive: true }).catch((err) => {
      console.error('[ws-server] Failed to create todos dir:', err?.message || String(err));
    });
  }
  return todosDirPromise;
}

async function writeTodoState(threadId, todos) {
  if (!threadId) return;
  try {
    await ensureTodosDir();
    const todoPath = `${TODOS_DIR}/${threadId}.json`;
    await writeFile(todoPath, JSON.stringify(todos));
    console.log(`[ws-server] Saved todo state threadId=${threadId} count=${todos.length}`);
  } catch (error) {
    console.error('[ws-server] Todo write failed:', error?.message || String(error));
  }
}

async function readTodoState(threadId) {
  if (!threadId) return null;
  try {
    const todoPath = `${TODOS_DIR}/${threadId}.json`;
    const content = await readFile(todoPath, 'utf-8');
    const todos = JSON.parse(content);
    console.log(`[ws-server] Loaded todo state threadId=${threadId} count=${todos.length}`);
    return todos;
  } catch {
    return null; // File doesn't exist or parse error
  }
}

async function clearTodoState(threadId) {
  if (!threadId) return;
  try {
    const todoPath = `${TODOS_DIR}/${threadId}.json`;
    await unlink(todoPath);
    console.log(`[ws-server] Cleared todo state threadId=${threadId}`);
  } catch {
    // File doesn't exist, that's fine
  }
}

// Extract TodoWrite todos from SDK events
function extractTodosFromEvent(event) {
  // Check assistant messages for TodoWrite tool_use blocks
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === 'tool_use' && block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
        return block.input.todos;
      }
    }
  }
  // Check streaming content_block_start for TodoWrite
  if (event?.type === 'stream_event' && event.event?.type === 'content_block_start') {
    const block = event.event.content_block;
    if (block?.type === 'tool_use' && block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
      return block.input.todos;
    }
  }
  return null;
}

// Sessions keyed by threadId
const sessions = new Map();
let integrationEnvVars = {};

function getSession(threadId, deployToken, userInfo) {
  if (sessions.has(threadId)) {
    return sessions.get(threadId);
  }
  const session = {
    threadId,
    deployToken,
    userName: userInfo?.userName,
    userEmail: userInfo?.userEmail,
    sockets: new Set(),
    events: [],
    nextEventId: 1,
    inputQueue: null,
    activeQuery: null,
  };
  sessions.set(threadId, session);
  return session;
}

function broadcast(session, payload) {
  const event = { ...payload, eventId: session.nextEventId++, sessionId: session.threadId };
  session.events.push(event);
  if (session.events.length > 500) session.events.shift();
  for (const ws of session.sockets) {
    try { ws.send(JSON.stringify(event)); } catch {}
  }
}

function sessionFileExists(sessionId) {
  try {
    const path = `${SYNC_DIR}/.claude/projects/-home-claude/${sessionId}.jsonl`;
    return Bun.file(path).size > 0;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT_APPEND = `
## About This Environment

You are running inside **Chiridion**, a web application that brings Claude Code to the browser. Users interact through a chat interface - they cannot see your terminal, localhost servers, or file system directly.

**Important constraints:**
- **localhost is not accessible** - Users cannot open localhost URLs. Deploy apps or output content directly.
- **Don't assume technical ability** - Users may not be developers. Explain in plain language.
- **Show results, not processes** - Deploy apps rather than telling users to run localhost.

## Multi-User Threads

Threads can have multiple users. Messages are prefixed with \`[Name (email)]: message\`. Pay attention to who is sending each message.

## File Sharing

- **\`/mnt/user-uploads/\`** - Files uploaded by the user
- **\`/mnt/user-outputs/\`** - Files you create for download

For downloadable files, use: \`[Link Text](chiridion://outputs/filename)\`

## Cloudflare Deployment

1. Use the globally installed \`wrangler\` CLI (don't install locally)
2. Build as Cloudflare Workers
3. Use Durable Objects with SQLite for persistence
4. Deploy with \`wrangler deploy\`
`;

function buildQueryOptions(session, resume) {
  const env = {
    ...process.env,
    ...integrationEnvVars,
    THREAD_ID: session.threadId,
  };

  if (session.deployToken) {
    env.CLOUDFLARE_API_TOKEN = session.deployToken;
  }

  const mcpServers = {};
  if (process.env.MCP_SERVER_URL && process.env.MCP_API_KEY) {
    mcpServers.chiridion = {
      type: 'http',
      url: process.env.MCP_SERVER_URL,
      headers: { Authorization: `Bearer ${process.env.MCP_API_KEY}` },
    };
  }

  return {
    model: 'opus',
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
    sandbox: { enabled: false, allowUnsandboxedCommands: true },
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_PROMPT_APPEND.trim() },
    settingSources: ['project', 'user'],
    env,
    // Capture CLI stderr for debugging
    stderr: (data) => {
      const msg = String(data).trim();
      if (msg) console.error(`[ws-server] CLI_STDERR threadId=${session.threadId}: ${msg.slice(0, 500)}`);
    },
    ...(Object.keys(mcpServers).length > 0 && { mcpServers, allowedTools: ['mcp__chiridion__*'] }),
    ...(resume ? { resume: session.threadId } : { extraArgs: { 'session-id': session.threadId } }),
  };
}

async function* messageStream(session) {
  const startTime = Date.now();
  console.log(`[ws-server] messageStream started threadId=${session.threadId}`);
  let msgCount = 0;
  for await (const msg of session.inputQueue) {
    msgCount++;
    const waitMs = Date.now() - startTime;
    console.log(`[ws-server] messageStream yield threadId=${session.threadId} msg=${msgCount} len=${msg.length} waitMs=${waitMs}`);
    yield { type: 'user', message: { role: 'user', content: msg } };
  }
  console.log(`[ws-server] messageStream ended threadId=${session.threadId} total=${msgCount}`);
}

async function startQuery(session) {
  if (session.activeQuery) return;

  const startTime = Date.now();
  const resume = sessionFileExists(session.threadId);
  console.log(`[ws-server] startQuery threadId=${session.threadId} resume=${resume} fileCheckMs=${Date.now() - startTime}`);

  const options = buildQueryOptions(session, resume);
  // inputQueue may already exist if message was pre-enqueued
  if (!session.inputQueue) {
    session.inputQueue = new MessageQueue();
  }

  const queryStartTime = Date.now();
  session.activeQuery = query({ prompt: messageStream(session), options });
  console.log(`[ws-server] query created threadId=${session.threadId} queryCreateMs=${Date.now() - queryStartTime}`);

  // Process events in background
  (async () => {
    let firstEventTime = null;
    let eventCount = 0;
    try {
      for await (const event of session.activeQuery) {
        eventCount++;
        if (!firstEventTime) {
          firstEventTime = Date.now();
          console.log(`[ws-server] firstEvent threadId=${session.threadId} type=${event?.type} waitMs=${firstEventTime - queryStartTime}`);
        }
        console.log(`[ws-server] event threadId=${session.threadId} type=${event?.type} count=${eventCount}`);
        broadcast(session, { type: 'sdk_event', event });

        // Check for TodoWrite tool calls and broadcast + persist
        const todos = extractTodosFromEvent(event);
        if (todos) {
          broadcast(session, { type: 'todo_state', todos });
          void writeTodoState(session.threadId, todos);
        }

        // Clear persisted todos when turn completes
        if (event?.type === 'result') {
          void clearTodoState(session.threadId);
        }
      }
    } catch (e) {
      console.error(`[ws-server] query error threadId=${session.threadId}:`, e);
      broadcast(session, { type: 'error', error: String(e) });
    } finally {
      console.log(`[ws-server] query ended threadId=${session.threadId} events=${eventCount} totalMs=${Date.now() - startTime}`);
      session.activeQuery = null;
      session.inputQueue = null;
    }
  })();
}

function formatAuthor(userName, userEmail) {
  if (userName && userEmail) return `[${userName} (${userEmail})]: `;
  if (userName) return `[${userName}]: `;
  if (userEmail) return `[${userEmail}]: `;
  return '';
}

async function handleMessage(session, content, userInfo) {
  const attributed = formatAuthor(userInfo?.userName, userInfo?.userEmail) + content;
  console.log(`[ws-server] message threadId=${session.threadId} len=${attributed.length}`);

  if (!session.activeQuery) {
    // Pre-create queue and enqueue message BEFORE starting query
    // This ensures message is ready when SDK starts consuming
    session.inputQueue = new MessageQueue();
    session.inputQueue.enqueue(attributed);
    console.log(`[ws-server] message pre-enqueued threadId=${session.threadId}`);
    await startQuery(session);
  } else {
    session.inputQueue?.enqueue(attributed);
  }
}

async function handleStop(session) {
  console.log(`[ws-server] stop threadId=${session.threadId}`);
  session.inputQueue?.close();
  try {
    await session.activeQuery?.interrupt();
  } catch {}
}

// HTTP + WebSocket server
Bun.serve({
  port: PORT,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', version: VERSION });
    }

    if (url.pathname === '/broadcast' && req.method === 'POST') {
      return req.json().then(data => {
        let sent = false;
        for (const session of sessions.values()) {
          for (const ws of session.sockets) {
            ws.send(JSON.stringify(data));
            sent = true;
          }
        }
        return sent ? new Response('ok') : new Response('No connections', { status: 503 });
      });
    }

    if (url.pathname === '/update-env' && req.method === 'POST') {
      return req.json().then(data => {
        if (data.env) {
          integrationEnvVars = data.env;
          return Response.json({ success: true, keys: Object.keys(data.env).length });
        }
        return Response.json({ success: false }, { status: 400 });
      });
    }

    if (req.headers.get('upgrade') === 'websocket') {
      const success = server.upgrade(req, {
        data: {
          deployToken: req.headers.get('x-chiridion-thread-deploy-token'),
          userName: req.headers.get('x-chiridion-user-name'),
          userEmail: req.headers.get('x-chiridion-user-email'),
        },
      });
      return success ? undefined : new Response('Upgrade failed', { status: 500 });
    }

    return new Response('Not found', { status: 404 });
  },

  websocket: {
    open(ws) {
      console.log('[ws-server] ws_open');
    },

    async message(ws, message) {
      try {
        const data = JSON.parse(message);

        if (data.type === 'init') {
          const threadId = data.threadId?.trim();
          if (!threadId) {
            ws.send(JSON.stringify({ type: 'error', error: 'Missing threadId' }));
            ws.close();
            return;
          }

          const session = getSession(threadId, ws.data?.deployToken, {
            userName: ws.data?.userName,
            userEmail: ws.data?.userEmail,
          });

          ws.data.threadId = threadId;
          session.sockets.add(ws);

          ws.send(JSON.stringify({ type: 'session', sessionId: threadId }));
          ws.send(JSON.stringify({ type: 'ready' }));

          // Send persisted todo state if exists
          const todos = await readTodoState(threadId);
          if (todos && todos.length > 0) {
            ws.send(JSON.stringify({ type: 'todo_state', todos }));
          }

          // Replay buffered events
          const lastId = data.lastEventId || 0;
          for (const event of session.events) {
            if (event.eventId > lastId) {
              ws.send(JSON.stringify(event));
            }
          }

          console.log(`[ws-server] init threadId=${threadId} sockets=${session.sockets.size} hasTodos=${!!todos}`);

        } else if (data.type === 'message') {
          const threadId = ws.data?.threadId;
          const session = sessions.get(threadId);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', error: 'No session' }));
            return;
          }
          await handleMessage(session, data.content, {
            userName: ws.data?.userName,
            userEmail: ws.data?.userEmail,
          });

        } else if (data.type === 'stop') {
          const session = sessions.get(ws.data?.threadId);
          if (session) await handleStop(session);
        }
      } catch (e) {
        console.error('[ws-server] message error:', e);
        ws.send(JSON.stringify({ type: 'error', error: String(e) }));
      }
    },

    close(ws) {
      const session = sessions.get(ws.data?.threadId);
      if (session) session.sockets.delete(ws);
      console.log(`[ws-server] ws_close threadId=${ws.data?.threadId}`);
    },
  },
});

console.log(`[ws-server] Listening on :${PORT}`);
