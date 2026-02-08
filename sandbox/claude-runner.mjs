import { query } from '@anthropic-ai/claude-agent-sdk';
import { access } from 'fs/promises';
import { createInterface } from 'readline';
import { loadUserProfile } from './memory-logger.mjs';

const SYNC_DIR = process.env.R2_MOUNT_DIR || '/home/sprite';
const THREAD_ID = process.env.CHIRIDION_THREAD_ID || process.env.THREAD_ID || '';
const MCP_SERVER_URL = process.env.MCP_SERVER_URL;
const THREAD_DEPLOY_TOKEN = process.env.CHIRIDION_THREAD_DEPLOY_TOKEN || '';
const MCP_TOKEN = process.env.CHIRIDION_MCP_TOKEN || '';

const keepAliveTimer = setInterval(() => {}, 60_000);

const session = {
  threadId: THREAD_ID,
  activeQuery: null,
  queryIterator: null,
  eventLoopRunning: false,
  initPromise: null,
  messageResolver: null,
  messageQueue: [],
  pendingQuestions: new Map(),
  userProfile: null,
};

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function logError(message, error) {
  const suffix = error ? ` ${String(error?.message || error)}` : '';
  process.stderr.write(`[claude-runner] ${message}${suffix}\n`);
}

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

function normalizeUserMessage(rawContent) {
  if (typeof rawContent !== 'string') return '';
  return rawContent.trim();
}

async function sessionFileExists(sessionId) {
  if (!sessionId) return false;
  const projectPath = '-home-sprite';
  const jsonlPath = `${SYNC_DIR}/.claude/projects/${projectPath}/${sessionId}.jsonl`;
  try {
    await access(jsonlPath);
    return true;
  } catch {
    return false;
  }
}

async function handleCanUseTool(toolName, input, opts) {
  if (toolName !== 'AskUserQuestion') {
    return { behavior: 'allow' };
  }

  const questions = input?.questions;
  if (!Array.isArray(questions) || questions.length === 0) {
    return { behavior: 'allow' };
  }

  const questionId = `q_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const toolUseId = opts?.toolUseID;

  const answerPromise = new Promise((resolve) => {
    session.pendingQuestions.set(questionId, {
      questionId,
      toolUseId,
      questions,
      resolve,
    });
  });

  send({
    type: 'ask_user_question',
    questionId,
    toolUseId,
    questions,
  });

  const answers = await answerPromise;
  return {
    behavior: 'allow',
    updatedInput: {
      questions,
      answers,
    },
  };
}

function handleQuestionResponse(questionId, answers) {
  const pending = session.pendingQuestions.get(questionId);
  if (!pending) return;

  session.pendingQuestions.delete(questionId);
  pending.resolve(answers);
  send({ type: 'question_answered', questionId });
}

function getQueryOptions(fileExists) {
  const envVars = {
    ...process.env,
    THREAD_ID: session.threadId,
  };

  if (THREAD_DEPLOY_TOKEN) {
    envVars.CLOUDFLARE_API_TOKEN = THREAD_DEPLOY_TOKEN;
  }

  const mcpServers = {};
  if (MCP_SERVER_URL && MCP_TOKEN) {
    mcpServers.chiridion = {
      type: 'http',
      url: MCP_SERVER_URL,
      headers: {
        Authorization: `Bearer ${MCP_TOKEN}`,
      },
    };
  }

  const options = {
    model: 'opus',
    fallbackModel: 'sonnet',
    includePartialMessages: true,
    permissionMode: 'bypassPermissions',
    allowUnsandboxedCommands: true,
    canUseTool: handleCanUseTool,
    ...(Object.keys(mcpServers).length > 0 && {
      mcpServers,
      allowedTools: ['mcp__chiridion__*'],
    }),
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: session.userProfile
        ? `\n\n## User Profile\n\n${session.userProfile}`
        : undefined,
    },
    settingSources: ['project', 'user'],
    env: envVars,
  };

  if (session.threadId) {
    if (fileExists) {
      options.resume = session.threadId;
    } else {
      options.extraArgs = { 'session-id': session.threadId };
    }
  }

  return options;
}

async function* createMessageStream() {
  while (true) {
    try {
      let message = null;
      if (session.messageQueue.length > 0) {
        message = session.messageQueue.shift();
      } else {
        message = await new Promise((resolve) => {
          session.messageResolver = resolve;
        });
      }

      if (message === null || message === undefined) {
        continue;
      }

      yield {
        type: 'user',
        message: {
          role: 'user',
          content: message,
        },
      };
    } catch (error) {
      logError('message stream error', error);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function initSession() {
  if (session.activeQuery || session.initPromise) {
    if (session.initPromise) await session.initPromise;
    return;
  }

  session.initPromise = (async () => {
    try {
      session.userProfile = await loadUserProfile().catch(() => null);
      const fileExists = await sessionFileExists(session.threadId);
      const options = getQueryOptions(fileExists);
      const messageStream = createMessageStream();

      session.activeQuery = query({ prompt: messageStream, options });
      session.queryIterator = session.activeQuery[Symbol.asyncIterator]();
    } catch (error) {
      logError('session init failed', error);
      send({ type: 'error', error: `Failed to initialize session: ${String(error)}` });
    }
  })();

  try {
    await session.initPromise;
  } finally {
    session.initPromise = null;
  }
}

function startEventLoop() {
  if (session.eventLoopRunning || !session.queryIterator) {
    return;
  }

  session.eventLoopRunning = true;

  (async () => {
    try {
      while (true) {
        const { value: event, done } = await session.queryIterator.next();

        if (done) {
          break;
        }

        send({ type: 'sdk_event', event });

        const todos = extractTodosFromEvent(event);
        if (todos) {
          send({ type: 'todo_state', todos });
        }
      }
    } catch (error) {
      logError('query loop error', error);
      send({ type: 'error', error: String(error) });
    } finally {
      session.activeQuery = null;
      session.queryIterator = null;
      session.eventLoopRunning = false;
    }
  })();
}

async function handleUserMessage(content) {
  const normalized = normalizeUserMessage(content);
  if (!normalized) return;

  await initSession();
  startEventLoop();

  if (session.messageResolver) {
    const resolver = session.messageResolver;
    session.messageResolver = null;
    resolver(normalized);
  } else {
    session.messageQueue.push(normalized);
  }
}

async function stopActiveQuery() {
  for (const [questionId, pending] of session.pendingQuestions) {
    session.pendingQuestions.delete(questionId);
    send({ type: 'question_answered', questionId });
    pending.resolve({});
  }

  if (session.activeQuery) {
    try {
      await session.activeQuery.interrupt();
    } catch (error) {
      logError('interrupt failed', error);
    }
  }
}

async function handleClientMessage(raw) {
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return;
  }

  if (data.type === 'message') {
    await handleUserMessage(data.content);
    return;
  }

  if (data.type === 'stop') {
    await stopActiveQuery();
    return;
  }

  if (data.type === 'question_response') {
    if (data.questionId && data.answers) {
      handleQuestionResponse(data.questionId, data.answers);
    }
  }
}

process.on('uncaughtException', (error) => {
  logError('uncaught exception', error);
  send({ type: 'error', error: String(error) });
});

process.on('unhandledRejection', (error) => {
  logError('unhandled rejection', error);
  send({ type: 'error', error: String(error) });
});

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on('line', (line) => {
  void handleClientMessage(line);
});

rl.on('close', () => {
  // Keep process alive while detached; the sprite exec session controls lifecycle.
});

process.on('SIGTERM', () => {
  clearInterval(keepAliveTimer);
  process.exit(0);
});

process.on('SIGINT', () => {
  clearInterval(keepAliveTimer);
  process.exit(0);
});
