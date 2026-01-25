import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'fs';
import { mkdir, writeFile, readFile, unlink } from 'fs/promises';

const VERSION = '2026-01-25-sdk-rewrite-v9';
const PORT = 8080;
const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/claude';
const SESSION_PROJECT_PATH = '-home-claude';
const TODOS_DIR = `${SYNC_DIR}/.chiridion/todos`;

console.log(`[ws-server] Starting version=${VERSION} port=${PORT}`);

// Catch unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ws-server] UNHANDLED REJECTION:', reason);
  console.error('[ws-server] Promise:', promise);
});

// Auth via ANTHROPIC_AUTH_TOKEN (OpenRouter) or ANTHROPIC_API_KEY (direct Anthropic)
if (!process.env.ANTHROPIC_AUTH_TOKEN && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_AUTH_TOKEN or ANTHROPIC_API_KEY required');
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

// Check if a session JSONL file exists (determines resume vs new session)
function sessionFileExists(sessionId) {
  if (!sessionId) return false;
  const jsonlPath = `${SYNC_DIR}/.claude/projects/${SESSION_PROJECT_PATH}/${sessionId}.jsonl`;
  const exists = existsSync(jsonlPath);
  console.log(`[ws-server] sessionFileExists: ${sessionId} => ${exists} (path: ${jsonlPath})`);
  return exists;
}

// Extract TodoWrite todos from SDK events
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
    // SDK query state
    activeQuery: null,
    pendingMessages: [],
    // AskUserQuestion state
    pendingQuestions: new Map(), // toolUseId -> { questionId, questions, resolve }
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

const SYSTEM_PROMPT_APPEND = `
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
`;

function buildSDKOptions(session) {
  const env = {
    ...process.env,
    ...integrationEnvVars,
    THREAD_ID: session.threadId,
  };

  if (session.deployToken) {
    env.CLOUDFLARE_API_TOKEN = session.deployToken;
  }

  // Create the canUseTool callback
  const canUseToolCallback = async (toolName, input, opts) => {
    return handleCanUseTool(session, toolName, input, opts);
  };

  const options = {
    model: 'opus',
    fallbackModel: 'sonnet',
    includePartialMessages: true,
    allowUnsandboxedCommands: true,
    cwd: existsSync(SYNC_DIR) ? SYNC_DIR : process.cwd(),
    // canUseTool callback - should be called for every tool (replaces bypassPermissions)
    canUseTool: canUseToolCallback,
    // Capture stderr from CLI for debugging
    stderr: (data) => {
      const msg = data.toString().trim();
      if (msg) {
        console.log(`[ws-server] CLI_STDERR threadId=${session.threadId}: ${msg.slice(0, 1000)}`);
      }
    },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: SYSTEM_PROMPT_APPEND.trim(),
    },
    settingSources: ['project', 'user'],
    env,
  };

  // Session handling: resume existing vs create new
  if (session.threadId) {
    if (sessionFileExists(session.threadId)) {
      // Resume existing session
      options.resume = session.threadId;
      console.log(`[ws-server] buildSDKOptions: RESUMING session threadId=${session.threadId}`);
    } else {
      // Create new session with specific ID
      options.extraArgs = { 'session-id': session.threadId };
      console.log(`[ws-server] buildSDKOptions: NEW session threadId=${session.threadId}`);
    }
  }

  console.log(`[ws-server] buildSDKOptions: canUseTool=${typeof options.canUseTool} resume=${!!options.resume} extraArgs=${JSON.stringify(options.extraArgs)} keys=${Object.keys(options).join(',')}`);

  // Add MCP config if available
  if (process.env.MCP_SERVER_URL && process.env.MCP_API_KEY) {
    options.mcpServers = {
      chiridion: {
        type: 'http',
        url: process.env.MCP_SERVER_URL,
        headers: { Authorization: `Bearer ${process.env.MCP_API_KEY}` },
      },
    };
    options.allowedTools = ['mcp__chiridion__*'];
  }

  return options;
}

// Handle tool interception via canUseTool callback
async function handleCanUseTool(session, toolName, input, opts) {
  console.log(`[ws-server] *** canUseTool CALLED *** threadId=${session.threadId} tool=${toolName}`);
  console.log(`[ws-server] canUseTool input: ${JSON.stringify(input)?.slice(0, 500)}`);
  console.log(`[ws-server] canUseTool opts: toolUseID=${opts?.toolUseID} agentID=${opts?.agentID} decisionReason=${opts?.decisionReason}`);

  if (toolName === 'AskUserQuestion') {
    const questions = input?.questions;

    if (!Array.isArray(questions) || questions.length === 0) {
      console.error(`[ws-server] Invalid AskUserQuestion input threadId=${session.threadId}`);
      return { behavior: 'allow' };
    }

    // Generate a unique ID for this question set
    const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const toolUseId = opts?.toolUseID;

    console.log(`[ws-server] AskUserQuestion threadId=${session.threadId} questionId=${questionId} numQuestions=${questions.length}`);

    // Create a promise that will be resolved when user responds
    const answerPromise = new Promise((resolve) => {
      session.pendingQuestions.set(questionId, {
        questionId,
        toolUseId,
        questions,
        resolve,
      });
    });

    // Broadcast question to all connected clients
    broadcast(session, {
      type: 'ask_user_question',
      questionId,
      toolUseId,
      questions,
    });

    // Wait for user response
    const answers = await answerPromise;

    console.log(`[ws-server] AskUserQuestion answered threadId=${session.threadId} questionId=${questionId}`);

    // Return allow with updated input containing answers
    return {
      behavior: 'allow',
      updatedInput: {
        questions,
        answers,
      },
    };
  }

  // Allow all other tools
  console.log(`[ws-server] canUseTool allowing tool=${toolName}`);
  return { behavior: 'allow' };
}

// Handle user's response to AskUserQuestion
function handleQuestionResponse(session, questionId, answers) {
  const pending = session.pendingQuestions.get(questionId);

  if (!pending) {
    console.error(`[ws-server] No pending question found for questionId=${questionId}`);
    return;
  }

  // Remove from pending
  session.pendingQuestions.delete(questionId);

  console.log(`[ws-server] Question response received threadId=${session.threadId} questionId=${questionId}`);

  // Resolve the promise with answers
  pending.resolve(answers);

  // Clear the question from UI
  broadcast(session, {
    type: 'question_answered',
    questionId,
  });
}

// Process SDK events from the query iterator
async function processSDKEvents(session, conversation) {
  console.log(`[ws-server] processSDKEvents STARTED threadId=${session.threadId}`);
  try {
    for await (const message of conversation) {
      // Detailed logging for each event type
      if (message.type === 'stream_event') {
        // Log stream event details
        const delta = message.event?.delta;
        if (delta?.type === 'text_delta') {
          // Don't log full text, just that we got text
          console.log(`[ws-server] stream_event: text_delta (${delta.text?.length || 0} chars)`);
        } else if (delta?.type === 'input_json_delta') {
          console.log(`[ws-server] stream_event: input_json_delta`);
        } else if (message.event?.type === 'content_block_start') {
          const block = message.event?.content_block;
          console.log(`[ws-server] stream_event: content_block_start type=${block?.type} name=${block?.name || 'n/a'}`);
          if (block?.type === 'tool_use') {
            console.log(`[ws-server] *** TOOL_USE BLOCK STARTED: ${block.name} ***`);
          }
        } else if (message.event?.type === 'content_block_stop') {
          console.log(`[ws-server] stream_event: content_block_stop`);
        } else {
          console.log(`[ws-server] stream_event: ${message.event?.type || 'unknown'}`);
        }
      } else if (message.type === 'assistant') {
        // Log assistant message with tool uses
        const content = message.message?.content || [];
        const toolUses = content.filter(b => b.type === 'tool_use');
        console.log(`[ws-server] assistant message: ${content.length} blocks, ${toolUses.length} tool_uses`);
        for (const tu of toolUses) {
          console.log(`[ws-server] *** TOOL_USE in assistant: ${tu.name} id=${tu.id} ***`);
        }
      } else if (message.type === 'user') {
        // Log user message (tool results)
        const content = message.message?.content || [];
        console.log(`[ws-server] user message: ${content.length} blocks`);
      } else if (message.type === 'result') {
        console.log(`[ws-server] RESULT: subtype=${message.subtype} is_error=${message.is_error}`);
      } else {
        console.log(`[ws-server] sdk_event threadId=${session.threadId} type=${message.type} subtype=${message.subtype || 'n/a'}`);
      }

      // Broadcast event to connected clients
      broadcast(session, { type: 'sdk_event', event: message });

      // Handle TodoWrite
      const todos = extractTodosFromEvent(message);
      if (todos) {
        broadcast(session, { type: 'todo_state', todos });
        void writeTodoState(session.threadId, todos);
      }

      // Clear todos and active query on result
      if (message.type === 'result') {
        void clearTodoState(session.threadId);
        session.activeQuery = null;

        // Process any pending messages
        if (session.pendingMessages.length > 0) {
          const nextMessage = session.pendingMessages.shift();
          void sendMessageToSDK(session, nextMessage);
        }
      }
    }
    console.log(`[ws-server] processSDKEvents ENDED (iterator done) threadId=${session.threadId} activeQuery=${!!session.activeQuery}`);
  } catch (err) {
    console.error(`[ws-server] SDK error threadId=${session.threadId}:`, err);
    console.error(`[ws-server] SDK error stack:`, err.stack);
    broadcast(session, { type: 'error', error: `SDK error: ${err.message}` });
    session.activeQuery = null;
  }
}

// Send a message to the SDK
async function sendMessageToSDK(session, content) {
  // If already processing, queue the message
  if (session.activeQuery) {
    console.log(`[ws-server] Queueing message (busy) threadId=${session.threadId}`);
    session.pendingMessages.push(content);
    return;
  }

  console.log(`[ws-server] Starting query threadId=${session.threadId} len=${content.length}`);

  const options = buildSDKOptions(session);
  console.log(`[ws-server] Query options: canUseTool=${typeof options.canUseTool} resume=${!!options.resume} extraArgs=${JSON.stringify(options.extraArgs)} model=${options.model}`);
  console.log(`[ws-server] Query options keys: ${Object.keys(options).join(', ')}`);

  // Start the query
  const conversation = query({
    prompt: content,
    options,
  });

  session.activeQuery = conversation;

  // Process events in the background
  void processSDKEvents(session, conversation);
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
  void sendMessageToSDK(session, attributed);
}

async function handleStop(session) {
  console.log(`[ws-server] stop threadId=${session.threadId}`);
  session.pendingMessages = [];

  // Abort the active query if possible
  if (session.activeQuery?.abort) {
    try {
      session.activeQuery.abort();
    } catch (err) {
      console.error(`[ws-server] Failed to abort query:`, err);
    }
  }
  session.activeQuery = null;

  // Clear any pending questions
  for (const [questionId, data] of session.pendingQuestions) {
    broadcast(session, { type: 'question_answered', questionId });
  }
  session.pendingQuestions.clear();
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

          // Send any pending questions to this client
          for (const [, data] of session.pendingQuestions) {
            ws.send(JSON.stringify({
              type: 'ask_user_question',
              questionId: data.questionId,
              toolUseId: data.toolUseId,
              questions: data.questions,
            }));
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

        } else if (data.type === 'question_response') {
          const threadId = ws.data?.threadId;
          const session = sessions.get(threadId);
          if (!session) {
            ws.send(JSON.stringify({ type: 'error', error: 'No session' }));
            return;
          }
          const { questionId, answers } = data;
          if (!questionId || !answers) {
            ws.send(JSON.stringify({ type: 'error', error: 'Missing questionId or answers' }));
            return;
          }
          handleQuestionResponse(session, questionId, answers);
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
