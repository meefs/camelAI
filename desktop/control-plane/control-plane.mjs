#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { access, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = parseInt(
  process.env.DESKTOP_RUNTIME_CONTROL_PLANE_PORT || '4317',
  10,
);
const SYSTEM_PROMPT =
  'You are camelAI Desktop. Be concise, practical, and helpful.';
const SHARED_ROOT =
  process.env.DESKTOP_RUNTIME_SHARED_DIR || '/mnt/camelai-shared';
const SHARED_LOG_DIR = `${SHARED_ROOT}/logs`;
const RUNTIME_STATUS_FILE = `${SHARED_ROOT}/runtime/status.txt`;
const DEFAULT_SDK_DEBUG_FILE = `${SHARED_LOG_DIR}/claude-sdk-debug.log`;
const DEFAULT_CONTROL_PLANE_LOG_FILE = `${SHARED_LOG_DIR}/control-plane.log`;
const CONTROL_PLANE_ROOT = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PROVIDER = process.env.DESKTOP_PROVIDER || 'claude';
const DEFAULT_CLAUDE_MODEL =
  process.env.DESKTOP_ANTHROPIC_MODEL || process.env.DESKTOP_MODEL || 'sonnet';
const DEFAULT_CODEX_MODEL =
  process.env.DESKTOP_CODEX_MODEL || process.env.DESKTOP_MODEL || 'gpt-5.4';
const CLAUDE_CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR || `${homedir()}/.claude`;
const CLAUDE_CREDENTIALS_PATH = `${CLAUDE_CONFIG_DIR}/.credentials.json`;
const CODEX_HOME = process.env.CODEX_HOME || `${homedir()}/.codex`;
const sessions = new Map();
let queryModulePromise = null;
let codexAppServerClient = null;
const processKeepAlive = setInterval(() => {}, 60 * 60 * 1000);

function getCodexExecutable() {
  for (const candidate of [
    resolve(CONTROL_PLANE_ROOT, 'node_modules/.bin/codex'),
    '/opt/camelai-desktop-guest/node_modules/.bin/codex',
    'codex',
  ]) {
    if (candidate === 'codex' || existsSync(candidate)) {
      return candidate;
    }
  }

  return 'codex';
}

async function getClaudeQuery() {
  if (!queryModulePromise) {
    queryModulePromise = import('@anthropic-ai/claude-agent-sdk').then(
      (module) => {
        if (typeof module.query !== 'function') {
          throw new Error('Claude Agent SDK did not export query().');
        }
        return module.query;
      },
    );
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

function getProviderFromEnv(sessionEnv = {}) {
  const provider = sessionEnv?.DESKTOP_PROVIDER;
  return provider === 'codex' ? 'codex' : 'claude';
}

function getDefaultModelForProvider(provider) {
  return provider === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL;
}

function getProjectSessionPath(threadId) {
  const projectPath = process.cwd().replace(/\//g, '-');
  return `${CLAUDE_CONFIG_DIR}/projects/${projectPath}/${threadId}.jsonl`;
}

function extractAssistantText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('');
}

function extractCodexItemText(item) {
  if (!item || typeof item !== 'object') {
    return '';
  }

  if (typeof item.text === 'string') {
    return item.text;
  }

  const message = item.message;
  if (message && typeof message === 'object') {
    return extractAssistantText(message.content);
  }

  return '';
}

function shouldRetryWithFreshThread(error) {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  const normalized = message.toLowerCase();

  return (
    normalized.includes('invalid request') ||
    normalized.includes('thread') ||
    normalized.includes('not found') ||
    normalized.includes('unknown')
  );
}

class CodexAppServerClient {
  constructor() {
    this.child = null;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pendingRequests = new Map();
    this.knownThreadIds = new Set();
    this.activeTurns = new Map();
    this.codexExecutable = getCodexExecutable();
  }

  dispose() {
    if (this.child && !this.child.killed) {
      this.child.kill();
    }
    this.handleExit(new Error('codex app-server stopped.'));
  }

  async runTurn(options) {
    await this.ensureStarted();

    const codexThreadId = await this.ensureThread(options);
    if (this.activeTurns.has(codexThreadId)) {
      throw new Error('A Codex turn is already active for this thread.');
    }

    const resultPromise = new Promise((resolvePromise, rejectPromise) => {
      this.activeTurns.set(codexThreadId, {
        desktopThreadId: options.threadId,
        codexThreadId,
        model: options.model,
        state: {
          streamedText: '',
          finalAssistantText: '',
          latestAssistantText: '',
        },
        onEvent: options.onEvent,
        onText: options.onText,
        resolve: resolvePromise,
        reject: rejectPromise,
        settled: false,
      });
    });

    try {
      const response = await this.request('turn/start', {
        threadId: codexThreadId,
        input: [{ type: 'text', text: options.content }],
        cwd: process.cwd(),
        approvalPolicy: 'never',
        model: options.model,
        summary: 'auto',
        personality: 'none',
      });

      if (response?.turn?.status === 'failed') {
        throw new Error(
          typeof response.turn?.error?.message === 'string'
            ? response.turn.error.message
            : 'Codex turn failed.',
        );
      }
    } catch (error) {
      this.failTurn(
        codexThreadId,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    return await resultPromise;
  }

  async ensureStarted() {
    if (this.child && this.child.stdin.writable) {
      return;
    }

    if (this.startPromise) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    await mkdir(CODEX_HOME, { recursive: true });

    logControlPlane('codex_app_server:start', {
      codexExecutable: this.codexExecutable,
      cwd: process.cwd(),
      codexHome: CODEX_HOME,
    });

    const child = spawn(this.codexExecutable, ['app-server'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CODEX_HOME,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.child = child;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pendingRequests.clear();
    this.knownThreadIds.clear();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderrBuffer += chunk;
      const trimmed = chunk.trim();
      if (trimmed) {
        logControlPlane('codex_app_server:stderr', {
          data: trimmed.slice(-1000),
        });
      }
    });
    child.on('error', (error) => {
      this.handleExit(
        error instanceof Error
          ? error
          : new Error('Failed to start codex app-server.'),
      );
    });
    child.on('close', (code, signal) => {
      this.handleExit(
        new Error(
          this.stderrBuffer.trim() ||
            `codex app-server exited (${signal ?? code ?? 'unknown'}).`,
        ),
      );
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'camelai_desktop_runtime',
        title: 'camelAI Desktop Runtime',
        version: '0.1.0',
      },
    });
    this.notify('initialized', {});
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.handleExit(new Error('codex app-server returned invalid JSON.'));
        return;
      }

      if (typeof message.method === 'string') {
        this.handleNotification(message);
      } else {
        this.handleResponse(message);
      }
    }
  }

  handleResponse(message) {
    if (typeof message.id !== 'number') {
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    if (message.error) {
      pending.reject(
        new Error(
          message.error.message
            ? `${pending.method}: ${message.error.message}`
            : `${pending.method} failed.`,
        ),
      );
      return;
    }

    pending.resolve(message.result);
  }

  handleNotification(message) {
    const params = message.params ?? {};
    const codexThreadId =
      typeof params.threadId === 'string' ? params.threadId : null;
    const activeTurn = codexThreadId
      ? this.activeTurns.get(codexThreadId) ?? null
      : null;

    activeTurn?.onEvent?.(message);

    if (!activeTurn) {
      return;
    }

    if (message.method === 'item/agentMessage/delta') {
      const delta = params.delta;
      if (typeof delta === 'string' && delta) {
        activeTurn.state.streamedText += delta;
        activeTurn.state.latestAssistantText += delta;
        activeTurn.onText(delta);
      }
      return;
    }

    if (message.method === 'item/completed') {
      const item = params.item;
      if (!item || typeof item !== 'object') {
        return;
      }

      if (item.type === 'agentMessage') {
        const nextText = extractCodexItemText(item);
        if (nextText) {
          activeTurn.state.finalAssistantText = nextText;
          if (
            nextText.startsWith(activeTurn.state.latestAssistantText) &&
            nextText.length > activeTurn.state.latestAssistantText.length
          ) {
            const delta = nextText.slice(activeTurn.state.latestAssistantText.length);
            activeTurn.state.streamedText += delta;
            activeTurn.onText(delta);
          }
          activeTurn.state.latestAssistantText = nextText;
        }
        return;
      }

      if (item.type === 'error') {
        this.failTurn(
          activeTurn.codexThreadId,
          new Error(
            typeof item.message === 'string'
              ? item.message
              : 'Codex turn failed.',
          ),
        );
      }
      return;
    }

    if (message.method === 'error') {
      if (params.willRetry === true) {
        return;
      }
      const error = params.error;
      this.failTurn(
        activeTurn.codexThreadId,
        new Error(
          error && typeof error.message === 'string'
            ? error.message
            : 'Codex turn failed.',
        ),
      );
      return;
    }

    if (message.method === 'turn/completed') {
      const turn = params.turn;
      if (turn?.status !== 'completed') {
        this.failTurn(
          activeTurn.codexThreadId,
          new Error(
            turn?.error && typeof turn.error.message === 'string'
              ? turn.error.message
              : 'Codex turn failed.',
          ),
        );
        return;
      }

      this.completeTurn(activeTurn.codexThreadId);
    }
  }

  async ensureThread(options) {
    const existingThreadId = options.sessionId?.trim();
    if (existingThreadId && this.knownThreadIds.has(existingThreadId)) {
      return existingThreadId;
    }

    if (existingThreadId) {
      try {
        const response = await this.request('thread/resume', {
          threadId: existingThreadId,
          cwd: process.cwd(),
          approvalPolicy: 'never',
          model: options.model,
          personality: 'none',
        });
        const resumedThreadId = response?.thread?.id || existingThreadId;
        this.knownThreadIds.add(resumedThreadId);
        options.onSessionId?.(resumedThreadId);
        return resumedThreadId;
      } catch (error) {
        if (!shouldRetryWithFreshThread(error)) {
          throw error;
        }

        logControlPlane('codex_app_server:thread_resume_fallback', {
          threadId: options.threadId,
          sessionId: existingThreadId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    const response = await this.request('thread/start', {
      cwd: process.cwd(),
      approvalPolicy: 'never',
      sandbox: 'workspace-write',
      model: options.model,
      personality: 'none',
    });
    const startedThreadId = response?.thread?.id;
    if (!startedThreadId) {
      throw new Error('Codex did not return a thread id.');
    }
    this.knownThreadIds.add(startedThreadId);
    options.onSessionId?.(startedThreadId);
    return startedThreadId;
  }

  completeTurn(codexThreadId) {
    const activeTurn = this.activeTurns.get(codexThreadId);
    if (!activeTurn || activeTurn.settled) {
      return;
    }

    activeTurn.settled = true;
    this.activeTurns.delete(codexThreadId);
    activeTurn.resolve({
      finalText:
        activeTurn.state.finalAssistantText || activeTurn.state.streamedText,
      model: activeTurn.model,
      sessionId: codexThreadId,
    });
  }

  failTurn(codexThreadId, error) {
    const activeTurn = this.activeTurns.get(codexThreadId);
    if (!activeTurn || activeTurn.settled) {
      return;
    }

    activeTurn.settled = true;
    this.activeTurns.delete(codexThreadId);
    activeTurn.reject(error);
  }

  notify(method, params) {
    this.send({ method, params });
  }

  async request(method, params) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not running.');
    }

    const id = this.nextRequestId++;
    return await new Promise((resolvePromise, rejectPromise) => {
      this.pendingRequests.set(id, {
        method,
        resolve: resolvePromise,
        reject: rejectPromise,
      });

      try {
        this.send({ id, method, params });
      } catch (error) {
        this.pendingRequests.delete(id);
        rejectPromise(
          error instanceof Error ? error : new Error(`${method} failed.`),
        );
      }
    });
  }

  send(message) {
    if (!this.child || !this.child.stdin.writable) {
      throw new Error('codex app-server is not running.');
    }

    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleExit(error) {
    if (!this.child && this.pendingRequests.size === 0 && this.activeTurns.size === 0) {
      return;
    }

    logControlPlane('codex_app_server:exit', {
      error: error instanceof Error ? error.message : String(error),
    });

    this.child = null;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.knownThreadIds.clear();

    for (const [requestId, pending] of this.pendingRequests.entries()) {
      this.pendingRequests.delete(requestId);
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }

    for (const [threadId, activeTurn] of this.activeTurns.entries()) {
      this.activeTurns.delete(threadId);
      if (!activeTurn.settled) {
        activeTurn.settled = true;
        activeTurn.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    }
  }
}

function getCodexAppServerClient() {
  if (!codexAppServerClient) {
    codexAppServerClient = new CodexAppServerClient();
  }
  return codexAppServerClient;
}

class ChatSession {
  constructor(
    threadId,
    sessionEnv = {},
    model = getDefaultModelForProvider(getProviderFromEnv(sessionEnv)),
    sessionId = null,
  ) {
    this.threadId = threadId;
    this.provider = getProviderFromEnv(sessionEnv);
    this.sessionEnv = sessionEnv;
    this.model = model;
    this.codexSessionId =
      typeof sessionId === 'string' && sessionId.trim() ? sessionId.trim() : null;
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
    this.activeCodexTurnPromise = null;
  }

  updateSessionConfig(
    sessionEnv = {},
    model = this.model,
    sessionId = null,
  ) {
    const nextProvider = getProviderFromEnv({
      ...this.sessionEnv,
      ...(sessionEnv && typeof sessionEnv === 'object' ? sessionEnv : {}),
    });
    const nextModel =
      typeof model === 'string' && model.trim()
        ? model.trim()
        : getDefaultModelForProvider(nextProvider);
    const providerChanged = nextProvider !== this.provider;
    const modelChanged = nextModel !== this.model;

    this.sessionEnv = {
      ...this.sessionEnv,
      ...(sessionEnv && typeof sessionEnv === 'object' ? sessionEnv : {}),
    };

    if (providerChanged || (nextProvider === 'claude' && modelChanged)) {
      this.needsReinit = true;
    }
    if (nextProvider === 'claude' && modelChanged) {
      this.discardSessionFileOnReinit = true;
    }

    this.provider = nextProvider;
    this.model = nextModel;

    if (typeof sessionId === 'string' && sessionId.trim()) {
      this.codexSessionId = sessionId.trim();
    }

    logControlPlane('session:update_config', {
      threadId: this.threadId,
      provider: this.provider,
      model: this.model,
      needsReinit: this.needsReinit,
      hasCodexSessionId: Boolean(this.codexSessionId),
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
      debugFile:
        process.env.DESKTOP_CONTROL_PLANE_DEBUG_FILE || DEFAULT_SDK_DEBUG_FILE,
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
    if (this.provider !== 'claude') {
      return;
    }

    if (this.needsReinit) {
      await this.resetRuntime();
      this.needsReinit = false;
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
        provider: this.provider,
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
      logControlPlane('session:query_created', {
        threadId: this.threadId,
        provider: this.provider,
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
      provider: this.provider,
      model: this.model,
      hasActiveQuery: Boolean(this.activeQuery),
      hasActiveCodexTurn: Boolean(this.activeCodexTurnPromise),
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
        sessionPath,
      });
    }

    this.activeQuery = null;
    this.queryIterator = null;
    this.eventLoopRunning = false;
    this.initPromise = null;
    this.messageQueue = [];
    this.activeCodexTurnPromise = null;
  }

  startEventLoop() {
    if (this.provider !== 'claude' || this.eventLoopRunning || !this.queryIterator) {
      return;
    }

    this.eventLoopRunning = true;
    logControlPlane('session:event_loop_start', {
      threadId: this.threadId,
      provider: this.provider,
      model: this.model,
    });

    (async () => {
      try {
        while (true) {
          const { value: event, done } = await this.queryIterator.next();
          if (done) {
            logControlPlane('session:event_loop_done', {
              threadId: this.threadId,
              provider: this.provider,
              model: this.model,
            });
            break;
          }

          logControlPlane('session:sdk_event', {
            threadId: this.threadId,
            provider: this.provider,
            model: this.model,
            eventType: event?.type,
            subtype: event?.subtype,
            streamType:
              event?.type === 'stream_event' ? event?.event?.type : undefined,
            deltaType:
              event?.type === 'stream_event'
                ? event?.event?.delta?.type
                : undefined,
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
          provider: this.provider,
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
          provider: this.provider,
          model: this.model,
        });
      }
    })();
  }

  async handleCodexMessage(trimmed) {
    if (this.needsReinit) {
      await this.resetRuntime();
      this.needsReinit = false;
    }

    if (this.activeCodexTurnPromise) {
      throw new Error('A Codex response is already streaming for this thread.');
    }

    const runPromise = getCodexAppServerClient().runTurn({
      threadId: this.threadId,
      content: trimmed,
      model: this.model,
      sessionId: this.codexSessionId,
      onEvent: (event) => {
        this.broadcast({
          type: 'runtime_event',
          threadId: this.threadId,
          event,
        });
      },
      onText: (delta) => {
        this.broadcast({
          type: 'assistant_delta',
          threadId: this.threadId,
          text: delta,
        });
      },
      onSessionId: (sessionId) => {
        this.codexSessionId = sessionId;
        this.broadcast({
          type: 'session_id',
          threadId: this.threadId,
          sessionId,
        });
      },
    });

    this.activeCodexTurnPromise = runPromise;

    try {
      const result = await runPromise;
      if (result?.sessionId) {
        this.codexSessionId = result.sessionId;
      }
      this.broadcast({
        type: 'result',
        threadId: this.threadId,
        result: result?.finalText || '',
        sessionId: result?.sessionId || this.codexSessionId || undefined,
      });
    } catch (error) {
      logControlPlane('session:codex_turn_error', {
        threadId: this.threadId,
        provider: this.provider,
        model: this.model,
        error: error instanceof Error ? error.message : String(error),
      });
      this.broadcast({
        type: 'error',
        error: error instanceof Error ? error.message : String(error),
        source: 'control_plane_codex_turn',
      });
    } finally {
      this.activeCodexTurnPromise = null;
    }
  }

  async handleMessage(content) {
    const trimmed = typeof content === 'string' ? content.trim() : '';
    if (!trimmed) {
      throw new Error('Message content cannot be empty.');
    }

    logControlPlane('session:handle_message', {
      threadId: this.threadId,
      provider: this.provider,
      model: this.model,
      length: trimmed.length,
      queueLength: this.messageQueue.length,
      hasCodexSessionId: Boolean(this.codexSessionId),
    });

    if (this.provider === 'codex') {
      await this.handleCodexMessage(trimmed);
      return;
    }

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

function getOrCreateSession(threadId, sessionEnv, model, sessionId) {
  let session = sessions.get(threadId);
  const resolvedProvider = getProviderFromEnv(sessionEnv);
  const resolvedModel =
    typeof model === 'string' && model.trim()
      ? model.trim()
      : getDefaultModelForProvider(resolvedProvider);

  if (!session) {
    session = new ChatSession(
      threadId,
      sessionEnv,
      resolvedModel,
      sessionId,
    );
    sessions.set(threadId, session);
  } else {
    session.updateSessionConfig(sessionEnv, resolvedModel, sessionId);
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

logControlPlane('bootstrap:start', {
  port: PORT,
  cwd: process.cwd(),
  provider: DEFAULT_PROVIDER,
  model:
    DEFAULT_PROVIDER === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL,
  claudeConfigDir: CLAUDE_CONFIG_DIR,
  codeHome: CODEX_HOME,
  codexExecutable: getCodexExecutable(),
  hasClaudeCredentialsFile: existsSync(CLAUDE_CREDENTIALS_PATH),
  hasAnthropicApiKey: Boolean(process.env.ANTHROPIC_API_KEY?.trim()),
  hasOpenAiApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
  resolvConf: (() => {
    try {
      return readFileSync('/etc/resolv.conf', 'utf8').trim().slice(0, 1000);
    } catch {
      return null;
    }
  })(),
});

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || '/',
    `http://${req.headers.host || `127.0.0.1:${PORT}`}`,
  );

  if (url.pathname === '/health') {
    sendJson(res, {
      ok: true,
      cwd: process.cwd(),
      provider: DEFAULT_PROVIDER,
      model:
        DEFAULT_PROVIDER === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL,
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
    const session = getOrCreateSession(
      threadId,
      message.env,
      message.model,
      message.sessionId,
    );

    logControlPlane('http:turn_start', {
      threadId,
      provider: session.provider,
      model: session.model,
      length: message.content.length,
      hasCodexSessionId: Boolean(session.codexSessionId),
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
            parsed?.type === 'result' ||
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
        provider: session.provider,
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
    provider: DEFAULT_PROVIDER,
    model:
      DEFAULT_PROVIDER === 'codex' ? DEFAULT_CODEX_MODEL : DEFAULT_CLAUDE_MODEL,
  });
});

server.on('error', (error) => {
  writeRuntimeStatus('control-plane-error');
  logControlPlane('server:error', {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exit(1);
});

function shutdown() {
  clearInterval(processKeepAlive);
  for (const session of sessions.values()) {
    session.shutdown();
  }
  codexAppServerClient?.dispose();
  process.exit(0);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
