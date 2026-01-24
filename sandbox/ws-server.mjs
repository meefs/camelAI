import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { existsSync } from 'fs';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';

const VERSION = '2026-01-24-async-messages-v1';
const PORT = 8080;
const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
const TODOS_DIR = `${SYNC_DIR}/.chiridion/todos`;

// Use SYNC_DIR if it exists, otherwise use current directory (for local testing)
const CLI_CWD = existsSync(SYNC_DIR) ? SYNC_DIR : process.cwd();

console.log(`[ws-server] Starting version=${VERSION} port=${PORT}`);

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY required');
  process.exit(1);
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
    return null;
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

// Extract TodoWrite todos from CLI events
function extractTodosFromEvent(event) {
  if (event?.type === 'assistant' && Array.isArray(event.message?.content)) {
    for (const block of event.message.content) {
      if (block?.type === 'tool_use' && block.name === 'TodoWrite' && Array.isArray(block.input?.todos)) {
        return block.input.todos;
      }
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
    cliProcess: null,
    pendingMessages: [],
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

function buildCLIArgs(session, resume) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
    '--allow-dangerously-skip-permissions',
    '--model', 'opus',
    '--append-system-prompt', SYSTEM_PROMPT_APPEND.trim(),
  ];

  if (resume) {
    args.push('--resume', session.threadId);
  } else {
    args.push('--session-id', session.threadId);
  }

  // Add MCP config if available
  if (process.env.MCP_SERVER_URL && process.env.MCP_API_KEY) {
    const mcpConfig = {
      mcpServers: {
        chiridion: {
          type: 'http',
          url: process.env.MCP_SERVER_URL,
          headers: { Authorization: `Bearer ${process.env.MCP_API_KEY}` },
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig));
    args.push('--allowedTools', 'mcp__chiridion__*');
  }

  return args;
}

function buildCLIEnv(session) {
  const env = {
    ...process.env,
    ...integrationEnvVars,
    THREAD_ID: session.threadId,
  };

  if (session.deployToken) {
    env.CLOUDFLARE_API_TOKEN = session.deployToken;
  }

  return env;
}

// Claude CLI - try multiple locations
function findClaudeCLI() {
  const paths = [
    process.env.CLAUDE_CLI_PATH,
    '/usr/local/bin/claude',
    '/root/.local/bin/claude',
    `${process.env.HOME}/.local/bin/claude`,
  ].filter(Boolean);

  for (const p of paths) {
    if (existsSync(p)) {
      console.log(`[ws-server] Found CLI at: ${p}`);
      return p;
    }
    console.log(`[ws-server] CLI not at: ${p}`);
  }
  console.log(`[ws-server] WARNING: CLI not found, falling back to 'claude'`);
  return 'claude';
}

const CLAUDE_CLI = findClaudeCLI();
console.log(`[ws-server] Using Claude CLI: ${CLAUDE_CLI}`);

// Spawns CLI and writes initialMessage once the process is ready
function spawnCLI(session, initialMessage) {
  const resume = sessionFileExists(session.threadId);
  const args = buildCLIArgs(session, resume);
  const env = buildCLIEnv(session);

  console.log(`[ws-server] spawning CLI threadId=${session.threadId} resume=${resume}`);

  const proc = spawn(CLAUDE_CLI, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    cwd: CLI_CWD,
  });

  session.cliProcess = proc;

  // Handle stderr
  proc.stderr.on('data', (data) => {
    const msg = data.toString().trim();
    if (msg) {
      console.error(`[ws-server] CLI_STDERR threadId=${session.threadId}: ${msg.slice(0, 500)}`);
    }
  });

  // Write initial message once process is ready
  // Check proc.pid in case 'spawn' already fired synchronously
  if (proc.pid) {
    // Already spawned - write initial message and flush queue
    if (initialMessage) {
      writeToStdin(session, initialMessage);
    }
    flushPendingMessages(session);
  } else {
    proc.once('spawn', () => {
      if (initialMessage) {
        writeToStdin(session, initialMessage);
      }
      flushPendingMessages(session);
    });
  }

  // Parse JSON lines from stdout
  const rl = createInterface({ input: proc.stdout });

  rl.on('line', (line) => {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);
      handleCLIEvent(session, event);
    } catch (e) {
      console.error(`[ws-server] Failed to parse CLI output: ${line.slice(0, 200)}`, e);
    }
  });

  // Handle process exit
  proc.on('exit', (code, signal) => {
    console.log(`[ws-server] CLI exited threadId=${session.threadId} code=${code} signal=${signal}`);
    session.cliProcess = null;

    // If messages were queued during spawn window, process them with a new CLI
    if (session.pendingMessages.length > 0) {
      const nextMessage = session.pendingMessages.shift();
      sendMessageToCLI(session, nextMessage);
    }
  });

  proc.on('error', (err) => {
    console.error(`[ws-server] CLI error threadId=${session.threadId}:`, err);
    session.cliProcess = null;
    broadcast(session, { type: 'error', error: `CLI error: ${err.message}` });
  });

  return proc;
}

// Flush any messages that queued during spawn
function flushPendingMessages(session) {
  while (session.pendingMessages.length > 0) {
    const msg = session.pendingMessages.shift();
    writeToStdin(session, msg);
  }
}

// Write a message to the CLI stdin
function writeToStdin(session, content) {
  const msg = {
    type: 'user',
    message: { role: 'user', content },
  };

  const msgStr = JSON.stringify(msg) + '\n';

  try {
    session.cliProcess.stdin.write(msgStr);
  } catch (err) {
    console.error(`[ws-server] stdin write error threadId=${session.threadId}:`, err);
    broadcast(session, { type: 'error', error: `Failed to send message: ${err.message}` });
  }
}

function handleCLIEvent(session, event) {
  console.log(`[ws-server] event threadId=${session.threadId} type=${event?.type}`);

  // Log system events for debugging
  if (event?.type === 'system') {
    console.log(`[ws-server] system_event threadId=${session.threadId} subtype=${event?.subtype} sessionId=${event?.session_id}`);
  }

  // Broadcast event to connected clients
  broadcast(session, { type: 'sdk_event', event });

  // Handle TodoWrite
  const todos = extractTodosFromEvent(event);
  if (todos) {
    broadcast(session, { type: 'todo_state', todos });
    void writeTodoState(session.threadId, todos);
  }

  // Clear todos on result
  if (event?.type === 'result') {
    void clearTodoState(session.threadId);
  }
}

function sendMessageToCLI(session, content) {
  // Spawn CLI if not running - message will be sent on 'spawn' event
  if (!session.cliProcess) {
    spawnCLI(session, content);
    return;
  }

  // If process exists but not yet spawned, queue the message
  if (!session.cliProcess.pid) {
    console.log(`[ws-server] Queueing message (spawning) threadId=${session.threadId}`);
    session.pendingMessages.push(content);
    return;
  }

  // CLI is running and spawned - write directly (async message support)
  writeToStdin(session, content);
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
  sendMessageToCLI(session, attributed);
}

async function handleStop(session) {
  console.log(`[ws-server] stop threadId=${session.threadId}`);
  session.pendingMessages = [];
  if (session.cliProcess) {
    session.cliProcess.kill('SIGTERM');
    session.cliProcess = null;
  }
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
