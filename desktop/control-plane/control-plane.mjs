#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
const PORT = parseInt(
  process.env.DESKTOP_RUNTIME_CONTROL_PLANE_PORT ||
    '4317',
  10,
);
const SYSTEM_PROMPT = 'You are camelAI Desktop. Be concise, practical, and helpful.';
const SHARED_ROOT = process.env.DESKTOP_RUNTIME_SHARED_DIR || '/mnt/camelai-shared';
const SHARED_LOG_DIR = `${SHARED_ROOT}/logs`;
const RUNTIME_STATUS_FILE = `${SHARED_ROOT}/runtime/status.txt`;
const DEFAULT_SDK_DEBUG_FILE = `${SHARED_LOG_DIR}/claude-sdk-debug.log`;
const DEFAULT_CONTROL_PLANE_LOG_FILE = `${SHARED_LOG_DIR}/control-plane.log`;
const CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
const CLAUDE_CREDENTIALS_PATH = `${CLAUDE_CONFIG_DIR}/.credentials.json`;
const sessions = new Map();
let queryModulePromise = null;
const processKeepAlive = setInterval(() => {}, 60 * 60 * 1000);

async function getClaudeQuery() {
  if (!queryModulePromise) {
    queryModulePromise = import('@anthropic-ai/claude-agent-sdk')
      .then((module) => {
        if (typeof module.query !== 'function') {
          throw new Error('Claude Agent SDK did not export query().');
        }
        return module.query;
      });
  }
  return queryModulePromise;
}

function logControlPlane(event, details = {}) {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    component: 'desktop-control-plane',
    event,
    ...details,
  };
  const line = `${JSON.stringify(payload)}\n`;
  process.stderr.write(line);
  try {
    appendFileSync(DEFAULT_CONTROL_PLANE_LOG_FILE, line, 'utf8');
  } catch {}
}

logControlPlane('bootstrap:start', {
  port: PORT,
  cwd: process.cwd(),
  model: process.env.DESKTOP_ANTHROPIC_MODEL || 'sonnet',
  claudeConfigDir: CLAUDE_CONFIG_DIR,
  hasClaudeCredentialsFile: existsSync(CLAUDE_CREDENTIALS_PATH),
  hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  resolvConf: (() => {
    try {
      return readFileSync('/etc/resolv.conf', 'utf8').trim().slice(0, 1000);
    } catch {
      return null;
    }
  })(),
});

function json(body, init = {}) {
  return {
    statusCode: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    body: JSON.stringify(body),
  };
}

function writeRuntimeStatus(value) {
  try {
    writeFileSync(RUNTIME_STATUS_FILE, `${value}\n`, 'utf8');
  } catch {}
}

function getProjectSessionPath(threadId) {
  const projectPath = process.cwd().replace(/\//g, '-');
  return `${homedir()}/.claude/projects/${projectPath}/${threadId}.jsonl`;
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

class ChatSession {
  constructor(threadId, sessionEnv = {}, model = process.env.DESKTOP_ANTHROPIC_MODEL || 'sonnet') {
    this.threadId = threadId;
    this.sessionEnv = sessionEnv;
    this.model = model;
    this.clients = new Set();
    this.messageQueue = [];
    this.messageResolver = null;
    this.activeQuery = null;
    this.queryIterator = null;
    this.eventLoopRunning = false;
    this.initPromise = null;
    this.nextOutboundSeq = 1;
    this.needsReinit = false;
    this.discardSessionFileOnReinit = false;
  }

  updateSessionConfig(sessionEnv = {}, model = this.model) {
    this.sessionEnv = {
      ...this.sessionEnv,
      ...(sessionEnv && typeof sessionEnv === 'object' ? sessionEnv : {}),
    };
    const nextModel = typeof model === 'string' && model.trim() ? model.trim() : this.model;
    if (nextModel !== this.model) {
      this.model = nextModel;
      this.needsReinit = true;
      this.discardSessionFileOnReinit = true;
    } else {
      this.model = nextModel;
    }
    logControlPlane('session:update_config', {
      threadId: this.threadId,
      model: this.model,
      needsReinit: this.needsReinit,
    });
  }

  addClient(client) {
    this.clients.add(client);
  }

  removeClient(client) {
    this.clients.delete(client);
  }

  broadcast(payload) {
    const sequencedPayload = {
      ...payload,
      seq: this.nextOutboundSeq++,
    };
    const encoded = JSON.stringify(sequencedPayload);
    for (const client of this.clients) {
      client.send(encoded);
    }
  }

  async sessionFileExists() {
    try {
      await access(getProjectSessionPath(this.threadId));
      return true;
    } catch {
      return false;
    }
  }

  getQueryOptions(fileExists) {
    const mergedEnv = {
      ...process.env,
      ...this.sessionEnv,
      THREAD_ID: this.threadId,
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
      CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: '1',
      CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS: '1',
    };

    const options = {
      executable: 'node',
      model: this.model,
      includePartialMessages: true,
      permissionMode: 'bypassPermissions',
      allowUnsandboxedCommands: true,
      settingSources: ['project'],
      env: mergedEnv,
      systemPrompt: {
        type: 'preset',
        preset: 'claude_code',
        append: SYSTEM_PROMPT,
      },
      debugFile: process.env.DESKTOP_CONTROL_PLANE_DEBUG_FILE || DEFAULT_SDK_DEBUG_FILE,
      stderr: (data) => {
        const trimmed = typeof data === 'string' ? data.trim() : '';
        if (trimmed) {
          logControlPlane('claude_sdk:stderr', {
            threadId: this.threadId,
            model: this.model,
            data: trimmed.slice(0, 1000),
          });
        }
      },
    };

    if (fileExists) {
      options.resume = this.threadId;
    } else {
      options.extraArgs = { 'session-id': this.threadId };
    }

    return options;
  }

  async *createMessageStream() {
    while (true) {
      let nextMessage = null;
      if (this.messageQueue.length > 0) {
        nextMessage = this.messageQueue.shift();
      } else {
        nextMessage = await new Promise((resolve) => {
          this.messageResolver = resolve;
        });
      }

      if (nextMessage === null) {
        return;
      }

      yield {
        type: 'user',
        message: {
          role: 'user',
          content: nextMessage,
        },
      };
    }
  }

  async init() {
    if (this.needsReinit) {
      await this.resetRuntime();
    }

    if (this.activeQuery || this.initPromise) {
      if (this.initPromise) {
        await this.initPromise;
      }
      return;
    }

    this.initPromise = (async () => {
      const hasSessionFile = await this.sessionFileExists();
      const query = await getClaudeQuery();
      const queryOptions = this.getQueryOptions(hasSessionFile);
      await mkdir(SHARED_LOG_DIR, { recursive: true });
      logControlPlane('session:init', {
        threadId: this.threadId,
        model: this.model,
        hasSessionFile,
        cwd: process.cwd(),
        claudeConfigDir: queryOptions.env.CLAUDE_CONFIG_DIR || null,
        hasClaudeCredentialsFile: existsSync(CLAUDE_CREDENTIALS_PATH),
        hasAnthropicApiKey: Boolean(queryOptions.env.ANTHROPIC_API_KEY?.trim()),
      });
      this.activeQuery = query({
        prompt: this.createMessageStream(),
        options: queryOptions,
      });
      this.queryIterator = this.activeQuery[Symbol.asyncIterator]();
      this.needsReinit = false;
      logControlPlane('session:query_created', {
        threadId: this.threadId,
        model: this.model,
        hasSessionFile,
      });
    })();

    try {
      await this.initPromise;
    } finally {
      this.initPromise = null;
    }
  }

  async resetRuntime() {
    logControlPlane('session:reset_runtime', {
      threadId: this.threadId,
      model: this.model,
      hasActiveQuery: Boolean(this.activeQuery),
    });

    if (this.messageResolver) {
      const resolve = this.messageResolver;
      this.messageResolver = null;
      resolve(null);
    }

    if (this.activeQuery) {
      await this.activeQuery.interrupt().catch(() => {});
    }

    if (this.discardSessionFileOnReinit) {
      const sessionPath = getProjectSessionPath(this.threadId);
      await rm(sessionPath, { force: true }).catch(() => {});
      this.discardSessionFileOnReinit = false;
      logControlPlane('session:discard_session_file', {
        threadId: this.threadId,
        model: this.model,
        sessionPath,
      });
    }

    this.activeQuery = null;
    this.queryIterator = null;
    this.eventLoopRunning = false;
    this.initPromise = null;
    this.messageQueue = [];
  }

  startEventLoop() {
    if (this.eventLoopRunning || !this.queryIterator) {
      return;
    }

    this.eventLoopRunning = true;
    logControlPlane('session:event_loop_start', {
      threadId: this.threadId,
      model: this.model,
    });

    (async () => {
      try {
        while (true) {
          const { value: event, done } = await this.queryIterator.next();
          if (done) {
            logControlPlane('session:event_loop_done', {
              threadId: this.threadId,
              model: this.model,
            });
            break;
          }
          logControlPlane('session:sdk_event', {
            threadId: this.threadId,
            model: this.model,
            eventType: event?.type,
            subtype: event?.subtype,
            streamType: event?.type === 'stream_event' ? event?.event?.type : undefined,
            deltaType: event?.type === 'stream_event' ? event?.event?.delta?.type : undefined,
          });
          this.broadcast({ type: 'sdk_event', event });
          if (event?.type === 'assistant') {
            const text = extractAssistantText(event.message?.content);
            if (text) {
              this.broadcast({
                type: 'assistant_text',
                threadId: this.threadId,
                text,
              });
            }
          }
        }
      } catch (error) {
        logControlPlane('session:event_loop_error', {
          threadId: this.threadId,
          model: this.model,
          error: error instanceof Error ? error.message : String(error),
        });
        this.broadcast({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          source: 'control_plane_event_loop',
        });
      } finally {
        this.activeQuery = null;
        this.queryIterator = null;
        this.eventLoopRunning = false;
        logControlPlane('session:event_loop_finish', {
          threadId: this.threadId,
          model: this.model,
        });
      }
    })();
  }

  async handleMessage(content) {
    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (!trimmed) {
      throw new Error('Message content cannot be empty.');
    }

    logControlPlane('session:handle_message', {
      threadId: this.threadId,
      model: this.model,
      length: trimmed.length,
      queueLength: this.messageQueue.length,
    });
    this.messageQueue.push(trimmed);
    if (this.messageResolver) {
      const resolve = this.messageResolver;
      this.messageResolver = null;
      resolve(this.messageQueue.shift() ?? null);
    }

    await this.init();
    this.startEventLoop();
  }

  async handleStop() {
    if (this.activeQuery) {
      await this.activeQuery.interrupt();
    }
  }

  shutdown() {
    if (this.messageResolver) {
      const resolve = this.messageResolver;
      this.messageResolver = null;
      resolve(null);
    }
    if (this.activeQuery) {
      this.activeQuery.interrupt().catch(() => {});
    }
  }
}

function getOrCreateSession(threadId, sessionEnv, model) {
  let session = sessions.get(threadId);
  if (!session) {
    session = new ChatSession(threadId, sessionEnv, model);
    sessions.set(threadId, session);
  } else {
    session.updateSessionConfig(sessionEnv, model);
  }
  return session;
}

function sendJson(res, body, init = {}) {
  const response = json(body, init);
  res.writeHead(response.statusCode, response.headers);
  res.end(response.body);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || `127.0.0.1:${PORT}`}`);

  if (url.pathname === '/health') {
    sendJson(res, {
      ok: true,
      cwd: process.cwd(),
      model: process.env.DESKTOP_ANTHROPIC_MODEL || 'sonnet',
    });
    return;
  }

  if (url.pathname === '/turn' && req.method === 'POST') {
    let message;
    try {
      message = await readJsonBody(req);
    } catch {
      sendJson(res, { error: 'Invalid JSON payload.' }, { status: 400 });
      return;
    }

    if (typeof message?.threadId !== 'string' || !message.threadId.trim()) {
      sendJson(res, { error: 'threadId is required.' }, { status: 400 });
      return;
    }

    if (typeof message?.content !== 'string' || !message.content.trim()) {
      sendJson(res, { error: 'content is required.' }, { status: 400 });
      return;
    }

    const threadId = message.threadId.trim();
    const session = getOrCreateSession(threadId, message.env, message.model);
    logControlPlane('http:turn_start', {
      threadId,
      model: message.model,
      length: message.content.length,
    });

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'Transfer-Encoding': 'chunked',
    });

    let cleanedUp = false;
    const client = {
      send(payload) {
        if (res.destroyed || res.writableEnded) {
          return;
        }
        try {
          res.write(`${payload}\n`);
          const parsed = JSON.parse(payload);
          if (
            parsed?.type === 'error' ||
            (parsed?.type === 'sdk_event' && parsed?.event?.type === 'result')
          ) {
            cleanup();
          }
        } catch (error) {
          logControlPlane('http:stream_send_error', {
            threadId,
            error: error instanceof Error ? error.message : String(error),
          });
          cleanup();
        }
      },
      close() {
        cleanup();
      },
    };

    const cleanup = () => {
      if (cleanedUp) {
        return;
      }
      cleanedUp = true;
      session.removeClient(client);
      if (!res.writableEnded) {
        res.end();
      }
    };

    session.addClient(client);
    req.once('aborted', () => {
      logControlPlane('http:turn_abort', { threadId });
      cleanup();
    });
    res.once('close', () => {
      logControlPlane('http:turn_close', { threadId });
      cleanup();
    });

    session.handleMessage(message.content).catch((error) => {
      logControlPlane('http:turn_error', {
        threadId,
        error: error instanceof Error ? error.message : String(error),
      });
      client.send(
        JSON.stringify({
          type: 'error',
          error: error instanceof Error ? error.message : String(error),
          source: 'control_plane_handle_message',
        }),
      );
    });
    return;
  }

  sendJson(res, { error: 'Not found' }, { status: 404 });
});

server.listen(PORT, () => {
  writeRuntimeStatus('control-plane-ready');
  logControlPlane('server:listening', {
    port: PORT,
    model: process.env.DESKTOP_ANTHROPIC_MODEL || 'sonnet',
  });
});

server.on('error', (error) => {
  writeRuntimeStatus('control-plane-error');
  logControlPlane('server:error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

process.on('SIGTERM', () => {
  clearInterval(processKeepAlive);
  for (const session of sessions.values()) {
    session.shutdown();
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  clearInterval(processKeepAlive);
  for (const session of sessions.values()) {
    session.shutdown();
  }
  process.exit(0);
});
