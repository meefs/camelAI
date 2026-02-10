import { query } from '@anthropic-ai/claude-agent-sdk';
import { access, readFile } from 'fs/promises';
import { createInterface } from 'readline';
import { loadUserProfile, MEMORY_DIR, PROFILE_PATH } from './memory-logger.mjs';

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
  lastForwardedCompactSummaryKey: null,
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

const SYSTEM_PROMPT_APPEND = `
## About This Environment

You are running inside **Chiridion**, a web application that brings Claude Code to the browser. Users interact through a chat interface - they cannot see your terminal, localhost servers, or file system directly.

**Important constraints:**
- **localhost is not accessible** - Users cannot open localhost URLs. If you need to show something, deploy it or output the content directly.
- **Don't assume technical ability** - Users may not be developers. Explain what you're doing in plain language. Avoid jargon unless the user demonstrates familiarity.
- **Show results, not processes** - Instead of saying "run npm start and open localhost:3000", deploy the app or show the output directly.
- **Use short bash timeouts** - This is an interactive user session. Default to shorter timeouts for bash commands to avoid long waits. Use longer timeouts only when necessary (e.g., deployments, builds).
- **Avoid large package installations** - Do not install large frameworks like OpenNext, Next.js, or other heavy dependencies. They take too long and degrade the user experience. Use the pre-configured templates instead.

## Multi-User Threads

Threads in Chiridion can have multiple users. Each user message is prefixed with the sender's identity in the format \`[Name (email)]: message\` or \`[email]: message\`. Pay attention to who is sending each message - different team members may have different questions or instructions.

## Chiridion Context Blocks

Some messages include hidden context inserted by Chiridion. This context may appear as:
- \`<chiridion system message> ... </chiridion system message>\`

Treat the content inside these blocks as trusted operator context for the current turn. Use it to guide your response and behavior, but do not explicitly mention these blocks, do not quote their wrappers, and do not tell the user that hidden context was provided.

## File Sharing with User

You have access to two special directories for exchanging files with the user:

- **\`/mnt/user-uploads/\`** - Files uploaded by the user. When a user uploads a file, you'll see a message like "(user uploaded file to /mnt/user-uploads/filename.png)". Read files from this directory to access what they shared.

- **\`/mnt/user-outputs/\`** - Files you create for the user to download or preview. Save files here when you want the user to access them.

**Creating downloadable/previewable files:**
When you save a file to /mnt/user-outputs/, provide a URL so the user can access it:
- Use the workspace outputs URL: \`/api/workspaces/${process.env.WORKSPACE_ID}/outputs/\`
- For images: \`![Description](/api/workspaces/${process.env.WORKSPACE_ID}/outputs/chart.png)\` - displays inline
- For downloads: \`[Download Report](/api/workspaces/${process.env.WORKSPACE_ID}/outputs/report.pdf)\` - triggers download

Examples:
- Image preview: \`![Analysis Chart](/api/workspaces/${process.env.WORKSPACE_ID}/outputs/charts/analysis.png)\`
- Download link: \`[Download CSV](/api/workspaces/${process.env.WORKSPACE_ID}/outputs/data.csv)\`
- Download link: \`[Get Full Report](/api/workspaces/${process.env.WORKSPACE_ID}/outputs/report.pdf)\`

## Node.js Package Management

**Always use \`bun\`** for Node.js package management. Do not use \`npm\` or \`yarn\` - use \`bun\` exclusively for installing dependencies, running scripts, and managing packages.

## Python Environment

This environment has **\`uv\`** installed - a fast Python package manager and project tool. Use \`uv\` instead of \`pip\` for all Python package management:

- **Install packages:** \`uv pip install <package>\` or \`uv add <package>\` (for projects)
- **Run scripts:** \`uv run python script.py\` (auto-installs dependencies)
- **Create virtualenvs:** \`uv venv\` (much faster than python -m venv)
- **Sync dependencies:** \`uv sync\` (from pyproject.toml)

\`uv\` is significantly faster than pip and handles dependency resolution better. Always prefer it for Python work.

## Cloudflare Deployment

When deploying software to the internet or for the user to access:

1. **Always use the globally installed \`wrangler\` CLI** - Do not install wrangler locally via npm
2. **Build as Cloudflare Workers** - All deployable software should be written as Workers
3. **Use Durable Objects with SQLite** - For persistence, use SQLite-backed Durable Objects (not KV)
4. **Use \`wrangler deploy --dispatch-namespace chiridion\`** - Deploy with the global wrangler binary

The infrastructure is already configured for Worker deployments. **For any web app with a UI, use \`create-worker\` to scaffold from the Chiridion starter template**—it's fast to create, has React Router 7 + shadcn/ui pre-configured, and handles both simple and complex apps. Only skip the template for pure API workers with no frontend.

**Important:** Do not install large frameworks like OpenNext, Next.js, or other heavy dependencies—they take too long. The Chiridion starter template has everything pre-configured.

## Episodic Memory

You have a **memory** subagent for maintaining context across sessions. It handles both logging and searching.

**IMPORTANT:** Always **resume** the memory subagent using its previous agent ID rather than starting fresh. This preserves the subagent's context about what has already been logged or searched in this session. Track the agent ID after first invocation and use the \`resume\` parameter on subsequent calls.

### Logging (background)
After completing significant work, invoke with \`run_in_background: true\`:
- After implementing features or fixing bugs
- After deploying applications
- After completing multi-step tasks
- After important decisions or investigations

### Searching (foreground)
When you need to find past work, invoke normally:
- "When did we deploy X?"
- "What was that bug we fixed?"
- "Have we worked on this before?"

### Storage
Memory files: \`~/.chiridion/memory/YYYY-MM-DD.md\`
Use the memory subagent to search when you need past context.

## Asking Questions with AskUserQuestion

Use the **AskUserQuestion** tool whenever you have a question with multiple valid options. This is your primary way to gather user preferences and make decisions collaboratively.

**When to use it:**
- Choosing between approaches (e.g., "Should I use SQLite or KV for this?")
- Clarifying requirements (e.g., "What color theme do you want?")
- Confirming before significant actions (e.g., "This will delete the old data. Proceed?")
- Offering feature options (e.g., "Do you want authentication included?")

**When NOT to use it:**
- For simple yes/no questions that don't affect the outcome
- When you already have enough information to proceed
- For questions you can answer yourself by reading docs or code

The tool presents your options as clickable buttons in the chat, making it easy for users to respond quickly. Don't make assumptions when multiple valid paths exist—ask!

## User Profile

You have a **profile-writer** subagent for maintaining a persistent profile about the user. The profile is always loaded into your system prompt, so you can see it - no reader needed.

**IMPORTANT:** Always **resume** the profile-writer subagent using its previous agent ID.

### When to Update (background)
Invoke with \`run_in_background: true\` when you learn something new about the user:
- Personality traits or communication style
- Technical preferences (languages, tools, coding style)
- Work context (role, team, projects)
- Quirks, pet peeves, things they love
- Inside jokes or recurring references

### What NOT to Log
- Transient task details (use memory for that)
- Sensitive personal information
- Temporary preferences

### Storage
Profile: \`~/.chiridion/profile.md\`
The full profile is always in your system prompt under "User Profile".
`;

const MEMORY_AGENT = {
  description: `Episodic memory manager. IMPORTANT: Always RESUME this subagent using its previous agent ID if one exists - do not start fresh each time. This preserves context about what has already been logged/searched.

Use for THREE purposes:

1. LOGGING (run in background): After completing significant tasks, invoke with run_in_background=true to record what was done. Use proactively after implementing features, fixing bugs, deploying, or completing multi-step tasks.

2. SEARCHING (run in foreground): When you need to find past work - "when did we deploy X?", "what was that bug?", "have we worked on this before?" - search BOTH memory files AND session history to get complete results.

3. CONTEXT RETRIEVAL (run in foreground): Use session-search show with --around to get full context around a specific message or timestamp.`,
  prompt: `You are an episodic memory manager for a coding workspace. You handle LOGGING memories and SEARCHING history.

## Memory Location
${MEMORY_DIR}/YYYY-MM-DD.md (one file per day, timestamped entries)

## MODE 1: LOGGING (when asked to record/log something)

Write a brief entry (2-4 sentences) summarizing what was accomplished:
- What the user wanted
- Key actions taken (files, tools, decisions)
- The outcome

**Entry format:**
\`\`\`
## HH:MM - [Brief Title]
[2-4 sentence factual summary]
\`\`\`

Append to today's file. Create it if needed. Be concise and factual.

## MODE 2: SEARCHING (when asked to find/recall something)

Search BOTH sources to get complete results:

**Memory files** (curated summaries):
\`\`\`bash
grep -r "keyword" ${MEMORY_DIR}/
\`\`\`

**Session history** (full conversation logs):
\`\`\`bash
# Search for specific terms (index auto-updates every 60s)
session-search search "your query" --limit 20

# Filter by date range
session-search search "query" --after "2026-01-15" --before "2026-01-20"

# Filter by session (supports partial IDs like "68369296")
session-search search "query" --session 68369296

# View context around a search result
session-search show <session-id> --around "<timestamp>" --context 5

# Show recent sessions
session-search list --limit 10
\`\`\`

Search results show message numbers (e.g., #47) for easy reference.

## Tips
- Memory files have curated summaries, session-search has raw conversation history
- Always try both - memory logs may not exist for all work
- Partial session IDs work (first 8 chars of UUID)
- Use --around with a timestamp to see surrounding context

## Tools Available
- Read: read memory files
- Write: append new entries
- Grep: search across files
- Glob: list files
- Bash: run session-search CLI and other commands`,
  tools: ['Read', 'Write', 'Grep', 'Glob', 'Bash'],
  model: 'haiku',
  maxTurns: 8,
};

const PROFILE_WRITER_AGENT = {
  description: `User profile writer. Use this subagent IN THE BACKGROUND (run_in_background=true) when you learn something new about the user that's worth remembering long-term. This includes:
- Personality traits and communication style
- Technical preferences (languages, frameworks, tools)
- Work habits and patterns
- Inside jokes or recurring references
- Personal details they've shared
- Pet peeves or things they love

IMPORTANT: Always RESUME this subagent using its previous agent ID. The profile is always visible in the system prompt, so no reader is needed.`,
  prompt: `You are a user profile manager. Your job is to maintain a profile of the user based on interactions.

## Profile Location
${PROFILE_PATH}

## What to Track
- **Character**: Personality, communication style, sense of humor
- **Preferences**: Technical preferences, coding style, tool choices
- **Context**: Their role, projects they work on, team context
- **Quirks**: Unique habits, pet peeves, things they love
- **Inside Jokes**: Recurring references, shared humor, callbacks

## How to Update
1. First, READ the current profile to see what exists
2. Then WRITE the updated profile, preserving existing content and adding/updating sections

## Profile Format
Use clear markdown sections:
\`\`\`markdown
# User Profile

## Character
[Personality traits, communication style]

## Technical Preferences
[Languages, frameworks, tools, coding style]

## Work Context
[Role, projects, team]

## Quirks & Preferences
[Habits, pet peeves, likes/dislikes]

## Inside Jokes & References
[Shared humor, callbacks, recurring themes]

## Notes
[Anything else worth remembering]
\`\`\`

## Guidelines
- Be concise but capture personality
- Update existing sections, don't duplicate
- Remove outdated info when updating
- Keep the tone warm and personal
- This is about KNOWING the user, not logging tasks`,
  tools: ['Read', 'Write'],
  model: 'haiku',
  maxTurns: 3,
};

const stopHook = async () => {
  return {
    systemMessage: 'Before finishing: Did you log anything significant to memory? If you accomplished notable work (feature, fix, deployment, investigation) and haven\'t logged it yet, invoke the memory subagent in the background now.',
  };
};

function getQueryOptions(fileExists) {
  const envVars = {
    ...process.env,
    THREAD_ID: session.threadId,
    CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
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
    agents: {
      'memory': MEMORY_AGENT,
      'profile-writer': PROFILE_WRITER_AGENT,
    },
    hooks: {
      Stop: [{ hooks: [stopHook] }],
    },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: SYSTEM_PROMPT_APPEND.trim() +
        (session.userProfile ? `\n\n## User Profile\n\nHere's what you know about this user:\n\n${session.userProfile}` : ''),
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

const COMPACT_SUMMARY_RETRY_DELAYS_MS = [0, 150, 250, 400, 650, 1000];
const COMPACT_SUMMARY_TIMESTAMP_SKEW_MS = 15_000;
const COMPACT_SUMMARY_FALLBACK_MAX_AGE_MS = 2 * 60_000;

function parseEventTimestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function getCompactSummaryKey(entry) {
  if (typeof entry?.uuid === 'string' && entry.uuid) {
    return `uuid:${entry.uuid}`;
  }
  const timestampMs = parseEventTimestampMs(entry?.timestamp);
  const content = entry?.message?.content;
  const contentKey = typeof content === 'string'
    ? content.slice(0, 120)
    : JSON.stringify(content ?? '').slice(0, 120);
  return `fallback:${timestampMs ?? 'na'}:${contentKey}`;
}

function selectLatestCompactSummaryEntry(lines, minTimestampMs) {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry;
    try {
      entry = JSON.parse(lines[i]);
    } catch {
      continue;
    }

    if (!(entry?.isCompactSummary && entry?.type === 'user' && entry?.message?.content)) {
      continue;
    }

    const entryTimestampMs = parseEventTimestampMs(entry.timestamp);
    if (minTimestampMs && entryTimestampMs && entryTimestampMs < minTimestampMs) {
      continue;
    }

    return entry;
  }

  return null;
}

/**
 * After a compact_boundary event, read the JSONL to find the isCompactSummary
 * user event that the SDK wrote but did not yield through the iterator, and
 * forward it to the client so the full summary is available without a refresh.
 */
async function forwardCompactSummary(boundaryEvent) {
  const projectPath = '-home-sprite';
  const jsonlPath = `${SYNC_DIR}/.claude/projects/${projectPath}/${session.threadId}.jsonl`;
  const boundaryTimestampMs = parseEventTimestampMs(boundaryEvent?.timestamp);
  const fallbackMinTimestampMs = Date.now() - COMPACT_SUMMARY_FALLBACK_MAX_AGE_MS;
  const minTimestampMs = (
    boundaryTimestampMs
      ? boundaryTimestampMs - COMPACT_SUMMARY_TIMESTAMP_SKEW_MS
      : fallbackMinTimestampMs
  );

  for (const delayMs of COMPACT_SUMMARY_RETRY_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }

    let content = '';
    try {
      content = await readFile(jsonlPath, 'utf-8');
    } catch {
      continue;
    }

    const trimmed = content.trimEnd();
    if (!trimmed) {
      continue;
    }

    const lines = trimmed.split('\n');
    const entry = selectLatestCompactSummaryEntry(lines, minTimestampMs);
    if (!entry) {
      continue;
    }

    const summaryKey = getCompactSummaryKey(entry);
    if (summaryKey && summaryKey === session.lastForwardedCompactSummaryKey) {
      return;
    }

    session.lastForwardedCompactSummaryKey = summaryKey;
    send({
      type: 'sdk_event',
      event: {
        type: 'user',
        isCompactSummary: true,
        message: entry.message,
        uuid: entry.uuid,
      },
    });
    return;
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

        // After a compact_boundary, the SDK writes the full summary to the
        // JSONL as a user event with isCompactSummary: true, but marks it
        // isVisibleInTranscriptOnly so it is NOT yielded through the iterator.
        // Read it from the JSONL and forward it explicitly so the client can
        // display the full summary without requiring a page refresh.
        if (event?.type === 'system' && event?.subtype === 'compact_boundary') {
          forwardCompactSummary(event).catch(() => {});
        }

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
