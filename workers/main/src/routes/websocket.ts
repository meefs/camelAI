/**
 * WebSocket routes for chat
 */

import { waitUntil } from 'cloudflare:workers';
import type { RouteContext } from '../types.js';
import { requireChatWebSocketAccess } from '../helpers/auth.js';
import { getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';
import { WorkspaceContainer } from '../workspace-container.js';
import { formatAttributedUserMessage } from '../chat-author-attribution.js';
import { injectFileSafetyMessage } from '../file-safety.js';
import {
  getThreadTitleSourceMessage,
  isPlaceholderThreadTitle,
  sanitizeGeneratedThreadTitle,
  THREAD_TITLE_GENERATION_SYSTEM_PROMPT,
} from '../../../../src/lib/thread-title.js';

export async function handleChatWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  const access = await requireChatWebSocketAccess(req, env, threadIdFromUrl);
  if ('error' in access) return access.error;

  const { session, orgId, workspaceId, threadId, userId } = access;

  const headers = new Headers(req.headers);
  headers.delete('X-Chiridion-User-Id');
  headers.delete('X-Chiridion-User-Name');
  headers.delete('X-Chiridion-User-Email');
  headers.set('X-Chiridion-User-Id', userId);
  if (session.user_name) headers.set('X-Chiridion-User-Name', session.user_name);
  if (session.user_email) headers.set('X-Chiridion-User-Email', session.user_email);

  const doUrl = new URL('https://chat-thread/chat');
  doUrl.searchParams.set('threadId', threadId);
  doUrl.searchParams.set('workspaceId', workspaceId);
  doUrl.searchParams.set('orgId', orgId);

  const modifiedReq = new Request(doUrl.toString(), { method: 'GET', headers });
  return getThreadStub(env, threadId).fetch(modifiedReq);
}

export async function handleChatRunnerWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const threadIdFromUrl = url.searchParams.get('threadId');
  if (!threadIdFromUrl) {
    return text('Missing threadId', 400);
  }

  const access = await requireChatWebSocketAccess(req, env, threadIdFromUrl);
  if ('error' in access) return access.error;

  const { session, orgId, workspaceId, threadId, userId } = access;

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  void bridgeChatSocket({
    server,
    env,
    orgId,
    workspaceId,
    threadId,
    userId,
    userName: session.user_name,
    userEmail: session.user_email,
  }).catch((error) => {
    console.error('[chat websocket] bridge failed', error);
    sendJson(server, {
      type: 'error',
      error: error instanceof Error ? error.message : 'Failed to connect chat runner',
    });
    closeWebSocket(server, 1011, 'chat runner failed');
  });

  return new Response(null, { status: 101, webSocket: client });
}

interface BridgeChatSocketArgs {
  server: WebSocket;
  env: RouteContext['env'];
  orgId: string;
  workspaceId: string;
  threadId: string;
  userId: string;
  userName?: string | null;
  userEmail?: string | null;
}

async function bridgeChatSocket(args: BridgeChatSocketArgs): Promise<void> {
  const {
    server,
    env,
    orgId,
    workspaceId,
    threadId,
    userId,
    userName,
    userEmail,
  } = args;

  let runnerSocket: WebSocket | null = null;
  let closed = false;
  const queuedClientMessages: string[] = [];
  const bridgeId = crypto.randomUUID();
  const startedAt = Date.now();

  const logBridge = (event: string, fields: Record<string, unknown> = {}) => {
    console.log('[chat runner bridge]', {
      event,
      bridgeId,
      threadId,
      workspaceId,
      orgId,
      elapsedMs: Date.now() - startedAt,
      ...fields,
    });
  };

  logBridge('created');

  const closeBoth = (code = 1000, reason = 'closed') => {
    if (closed) return;
    closed = true;
    logBridge('close_both', { code, reason });
    closeWebSocket(server, code, reason);
    if (runnerSocket) {
      closeWebSocket(runnerSocket, code, reason);
    }
  };

  const sendToRunner = (message: Record<string, unknown>) => {
    const type = typeof message.type === 'string' ? message.type : 'unknown';
    if (!runnerSocket || runnerSocket.readyState !== WebSocket.OPEN) {
      logBridge('forward_skipped_runner_not_open', {
        type,
        runnerReadyState: runnerSocket?.readyState ?? null,
      });
      return false;
    }
    runnerSocket.send(JSON.stringify(message));
    logBridge('forwarded_to_runner', { type });
    return true;
  };

  const updateThreadMetadata = (messageContent: string) => {
    waitUntil(
      updateThreadMetadataForUserMessage(env, orgId, threadId, messageContent)
        .catch((error) => {
          console.error('[chat websocket] failed to update thread metadata', error);
        }),
    );
  };

  const handleClientMessage = (raw: string) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'init') {
      logBridge('client_init_ignored');
      return;
    }

    if (type !== 'ping') {
      logBridge('client_message_received', {
        type,
        rawBytes: raw.length,
      });
    }

    if (type === 'message') {
      const rawContent = typeof data.content === 'string' ? data.content : '';
      const attributedContent = formatAttributedUserMessage(
        injectFileSafetyMessage(rawContent),
        { userName, userEmail },
      );
      if (!attributedContent) return;
      logBridge('client_user_message_prepared', {
        rawLength: rawContent.length,
        attributedLength: attributedContent.length,
      });
      sendJson(server, { type: 'streaming_state', isStreaming: true });
      updateThreadMetadata(attributedContent);
      return sendToRunner({
        ...data,
        type: 'message',
        content: attributedContent,
        threadId,
        userId,
      });
    }

    return sendToRunner({ ...data, threadId });
  };

  server.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    if (!runnerSocket || runnerSocket.readyState !== WebSocket.OPEN) {
      try {
        const data = JSON.parse(event.data) as { type?: unknown };
        if (data.type !== 'init') {
          queuedClientMessages.push(event.data);
          logBridge('client_message_queued', {
            type: typeof data.type === 'string' ? data.type : 'unknown',
            queueLength: queuedClientMessages.length,
            runnerReadyState: runnerSocket?.readyState ?? null,
          });
        }
      } catch {
        // Ignore invalid JSON while the runner is starting.
      }
      return;
    }
    handleClientMessage(event.data);
  });
  server.addEventListener('close', (event) => {
    logBridge('client_closed', {
      code: event.code || 1000,
      reason: event.reason || 'client closed',
      queuedMessages: queuedClientMessages.length,
    });
    closeBoth(event.code || 1000, event.reason || 'client closed');
  });
  server.addEventListener('error', () => {
    logBridge('client_error', { queuedMessages: queuedClientMessages.length });
    closeBoth(1011, 'client error');
  });

  const container = new WorkspaceContainer(env, workspaceId, orgId);
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.getThread(threadId);
  const provider = thread?.provider === 'codex' ? 'codex' : 'claude';
  logBridge('runner_connect_start', { provider });
  const { envVars, byokProxy } = await container.buildChatRunnerEnv({
    threadId,
    provider,
  });

  runnerSocket = await container.connectChatWebSocket({
    threadId,
    userId,
    byokProxy,
  });
  runnerSocket.accept();
  logBridge('runner_connected', {
    provider,
    byokProxy: Boolean(byokProxy),
  });

  runnerSocket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    payload.sessionId = threadId;

    const eventType = typeof payload.type === 'string' ? payload.type : '';
    const runtimeEvent = payload.event as { method?: unknown } | undefined;
    if (
      eventType === 'ready' ||
      eventType === 'error' ||
      eventType === 'result' ||
      eventType === 'streaming_state' ||
      runtimeEvent?.method === 'turn/completed'
    ) {
      logBridge('runner_event', {
        type: eventType || null,
        method: typeof runtimeEvent?.method === 'string' ? runtimeEvent.method : null,
      });
    }
    if (eventType === 'todo_state' && Array.isArray(payload.todos)) {
      const chatThread = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId)) as unknown as {
        setTodoState(todos: unknown[]): Promise<void>;
      };
      waitUntil(
        chatThread.setTodoState(payload.todos).catch((error) => {
          console.error('[chat websocket] failed to persist todo state', error);
        }),
      );
    }
    if (
      eventType === 'error' ||
      eventType === 'result' ||
      runtimeEvent?.method === 'turn/completed'
    ) {
      sendJson(server, { type: 'streaming_state', isStreaming: false });
    }

    sendJson(server, payload);
  });
  runnerSocket.addEventListener('close', (event) => {
    logBridge('runner_closed', {
      code: event.code || 1000,
      reason: event.reason || 'runner closed',
      queuedMessages: queuedClientMessages.length,
    });
    closeBoth(event.code || 1000, event.reason || 'runner closed');
  });
  runnerSocket.addEventListener('error', () => {
    logBridge('runner_error', { queuedMessages: queuedClientMessages.length });
    closeBoth(1011, 'runner error');
  });

  sendJson(server, { type: 'streaming_state', isStreaming: false });
  runnerSocket.send(JSON.stringify({
    type: 'init',
    threadId,
    env: envVars,
    lastSeq: 0,
  }));
  logBridge('runner_init_sent');

  while (queuedClientMessages.length > 0 && runnerSocket.readyState === WebSocket.OPEN) {
    const raw = queuedClientMessages.shift();
    if (!raw) continue;
    logBridge('flushing_queued_client_message', {
      remainingQueueLength: queuedClientMessages.length,
    });
    handleClientMessage(raw);
  }
}

async function updateThreadMetadataForUserMessage(
  env: RouteContext['env'],
  orgId: string,
  threadId: string,
  messageContent: string,
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.getThread(threadId);
  if (!thread) return;

  await orgStub.touchThread(threadId);

  const titleSourceMessage = getThreadTitleSourceMessage(messageContent);
  if (!titleSourceMessage) return;

  const hasFirstUserMessage =
    typeof thread.first_user_message === 'string' &&
    thread.first_user_message.trim().length > 0;
  if (hasFirstUserMessage) return;

  await orgStub.setThreadFirstUserMessage(threadId, titleSourceMessage);

  if (!isPlaceholderThreadTitle(thread.title)) return;

  try {
    const response = await env.AI.run('@cf/google/gemma-3-12b-it', {
      messages: [
        { role: 'system', content: THREAD_TITLE_GENERATION_SYSTEM_PROMPT },
        { role: 'user', content: titleSourceMessage },
      ],
      temperature: 1,
      max_tokens: 50,
    }) as { response?: string };

    const title = sanitizeGeneratedThreadTitle(response?.response);
    if (title) {
      await orgStub.updateThread(threadId, title);
    }
  } catch (error) {
    console.error('[chat websocket] failed to generate thread title', error);
  }
}

function sendJson(ws: WebSocket, payload: unknown): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify(payload));
  } catch {
    // The close/error handlers will clean up the peer socket.
  }
}

function closeWebSocket(ws: WebSocket, code: number, reason: string): void {
  try {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason);
    }
  } catch {
    // Ignore close races.
  }
}
