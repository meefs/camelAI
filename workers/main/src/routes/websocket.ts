/**
 * WebSocket routes for chat
 */

import { waitUntil } from 'cloudflare:workers';
import type { RouteContext } from '../types.js';
import { requireChatWebSocketAccess, requireWorkspaceAccess } from '../helpers/auth.js';
import { getThreadStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';
import { WorkspaceContainer } from '../workspace-container.js';
import {
  formatAttributedUserMessage,
  type ChatAuthorIdentity,
} from '../chat-author-attribution.js';
import { injectFileSafetyMessage } from '../file-safety.js';
import { applyConnectionMentionContext } from '../connection-mention-context.js';
import {
  getThreadTitleSourceMessage,
  isPlaceholderThreadTitle,
} from '../../../../src/lib/thread-title.js';
import { generateThreadTitleWithOpenAI } from '../../../../src/lib/thread-title-generation.server.js';
import { recordWorkspaceThreadStreaming } from '../thread-status.js';

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

export async function handleWorkspaceStatusWebSocket({
  req,
  env,
  match,
}: RouteContext): Promise<Response> {
  const workspaceIdFromPath = decodeURIComponent(match[1] ?? '').trim();
  if (!workspaceIdFromPath) {
    return text('Missing workspaceId', 400);
  }

  const access = await requireWorkspaceAccess(req, env);
  if ('error' in access) return access.error;
  if (access.workspaceId !== workspaceIdFromPath) {
    return text('Forbidden', 403);
  }

  const doUrl = new URL('https://workspace/status');
  const modifiedReq = new Request(doUrl.toString(), {
    method: 'GET',
    headers: req.headers,
  });
  return access.wsStub.fetch(modifiedReq);
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

export async function bridgeChatSocket(args: BridgeChatSocketArgs): Promise<void> {
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
  let clientConnected = true;
  let activeOrPendingUserTurn = false;
  let suppressNextRunnerCloseIdle = false;
  const queuedClientMessages: string[] = [];
  let clientMessageChain = Promise.resolve();
  const bridgeId = crypto.randomUUID();
  const startedAt = Date.now();
  let completionRecordedAt: number | null = null;
  let clientLastSeq = 0;

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
      suppressNextRunnerCloseIdle = !activeOrPendingUserTurn && completionRecordedAt === null;
      closeWebSocket(runnerSocket, code, reason);
    }
  };
  const closeClient = (code = 1000, reason = 'client closed') => {
    clientConnected = false;
    closeWebSocket(server, code, reason);
  };
  const shouldKeepRunnerAfterClientClose = () => activeOrPendingUserTurn;
  const closeDetachedRunnerIfDone = (reason: string) => {
    if (!clientConnected && !activeOrPendingUserTurn) {
      closeBoth(1000, reason);
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
      updateThreadMetadataForUserMessage(
        env,
        orgId,
        workspaceId,
        threadId,
        userId,
        messageContent,
      )
        .catch((error) => {
          console.error('[chat websocket] failed to update thread metadata', error);
        }),
    );
  };
  const recordStreaming = (isStreaming: boolean) => {
    activeOrPendingUserTurn = isStreaming;
    if (isStreaming) completionRecordedAt = null;
    waitUntil(
      recordWorkspaceThreadStreaming(env, workspaceId, threadId, isStreaming).catch((error) => {
        console.error('[chat websocket] failed to record workspace thread status', error);
      }),
    );
  };
  const recordAssistantCompletion = (rawCompletedAt?: unknown) => {
    const completedAt = normalizeCompletionTimestamp(rawCompletedAt);
    activeOrPendingUserTurn = false;
    if (completionRecordedAt !== null) return completionRecordedAt;
    completionRecordedAt = completedAt;
    waitUntil(
      recordThreadAssistantCompletion(
        env,
        orgId,
        workspaceId,
        threadId,
        completedAt,
      ).catch((error) => {
        console.error('[chat websocket] failed to record assistant completion', error);
      }),
    );
    return completedAt;
  };
  const updateClientLastSeq = (value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    clientLastSeq = Math.max(clientLastSeq, Math.max(0, Math.floor(value)));
  };

  const handleClientMessage = async (raw: string) => {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    const type = typeof data.type === 'string' ? data.type : '';
    if (type === 'init') {
      updateClientLastSeq(data.lastSeq);
      updateClientLastSeq(data.lastEventId);
      logBridge('client_init_recorded', { lastSeq: clientLastSeq });
      return;
    }

    if (type !== 'ping') {
      logBridge('client_message_received', {
        type,
        rawBytes: raw.length,
      });
    }

    if (type === 'message') {
      activeOrPendingUserTurn = true;
      const rawContent = typeof data.content === 'string' ? data.content : '';
      const attributedContent = await buildRunnerUserMessageContent(
        env,
        workspaceId,
        rawContent,
        { userName, userEmail },
      );
      if (!attributedContent) {
        activeOrPendingUserTurn = false;
        return;
      }
      logBridge('client_user_message_prepared', {
        rawLength: rawContent.length,
        attributedLength: attributedContent.length,
      });
      sendJson(server, { type: 'streaming_state', isStreaming: true });
      recordStreaming(true);
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
    if (closed) return;
    if (typeof event.data !== 'string') return;
    if (!runnerSocket || runnerSocket.readyState !== WebSocket.OPEN) {
      try {
        const data = JSON.parse(event.data) as { type?: unknown };
        if (data.type === 'init') {
          clientMessageChain = clientMessageChain
            .then(() => handleClientMessage(event.data as string))
            .catch((error) => {
              console.error('[chat websocket] failed to handle client init', error);
            });
          return;
        }
        if (data.type === 'message') {
          activeOrPendingUserTurn = true;
        }
        queuedClientMessages.push(event.data);
        logBridge('client_message_queued', {
          type: typeof data.type === 'string' ? data.type : 'unknown',
          queueLength: queuedClientMessages.length,
          runnerReadyState: runnerSocket?.readyState ?? null,
        });
      } catch {
        // Ignore invalid JSON while the runner is starting.
      }
      return;
    }
    clientMessageChain = clientMessageChain
      .then(() => handleClientMessage(event.data as string))
      .catch((error) => {
        console.error('[chat websocket] failed to handle client message', error);
        sendJson(server, {
          type: 'error',
          error: 'Failed to send message to chat runner',
        });
      });
  });
  server.addEventListener('close', (event) => {
    logBridge('client_closed', {
      code: event.code || 1000,
      reason: event.reason || 'client closed',
      queuedMessages: queuedClientMessages.length,
    });
    closeClient(event.code || 1000, event.reason || 'client closed');
    if (shouldKeepRunnerAfterClientClose()) {
      logBridge('client_detached_runner_kept', {
        queuedMessages: queuedClientMessages.length,
      });
      return;
    }
    closeBoth(event.code || 1000, event.reason || 'client closed');
  });
  server.addEventListener('error', () => {
    logBridge('client_error', { queuedMessages: queuedClientMessages.length });
    closeClient(1011, 'client error');
    if (shouldKeepRunnerAfterClientClose()) {
      logBridge('client_error_runner_kept', {
        queuedMessages: queuedClientMessages.length,
      });
      return;
    }
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
  if (closed) {
    closeWebSocket(runnerSocket, 1000, 'client closed');
    return;
  }
  runnerSocket.accept();
  logBridge('runner_connected', {
    provider,
    byokProxy: Boolean(byokProxy),
  });

  runnerSocket.addEventListener('message', (event) => {
    if (closed) return;
    if (typeof event.data !== 'string') return;
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    payload.sessionId = threadId;

    const eventType = typeof payload.type === 'string' ? payload.type : '';
    const seq =
      typeof payload.seq === 'number' && Number.isFinite(payload.seq)
        ? Math.max(0, Math.floor(payload.seq))
        : null;
    if (seq !== null && typeof payload.eventId !== 'number') {
      payload.eventId = seq;
    }
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
    if (eventType === 'streaming_state' && typeof payload.isStreaming === 'boolean') {
      if (payload.isStreaming) {
        recordStreaming(true);
      } else {
        const completedAt = normalizeCompletionTimestampOrNull(payload.completedAt);
        if (activeOrPendingUserTurn) {
          recordAssistantCompletion(completedAt);
        } else {
          recordStreaming(false);
        }
        closeDetachedRunnerIfDone('runner completed after client detached');
      }
    }
    if (eventType === 'error') {
      sendJson(server, { type: 'streaming_state', isStreaming: false });
      if (completionRecordedAt === null) {
        recordStreaming(false);
      }
      closeDetachedRunnerIfDone('runner errored after client detached');
    }
    if (eventType === 'result' || runtimeEvent?.method === 'turn/completed') {
      const completedAt = recordAssistantCompletion(payload.completedAt);
      sendJson(server, { type: 'streaming_state', isStreaming: false, completedAt });
      closeDetachedRunnerIfDone('runner completed after client detached');
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
    const suppressIdle = suppressNextRunnerCloseIdle;
    suppressNextRunnerCloseIdle = false;
    if (!suppressIdle && completionRecordedAt === null) {
      recordStreaming(false);
    }
  });
  runnerSocket.addEventListener('error', () => {
    logBridge('runner_error', { queuedMessages: queuedClientMessages.length });
    closeBoth(1011, 'runner error');
    const suppressIdle = suppressNextRunnerCloseIdle;
    suppressNextRunnerCloseIdle = false;
    if (!suppressIdle && completionRecordedAt === null) {
      recordStreaming(false);
    }
  });

  await clientMessageChain;
  runnerSocket.send(JSON.stringify({
    type: 'init',
    threadId,
    env: envVars,
    lastSeq: clientLastSeq,
  }));
  logBridge('runner_init_sent', { lastSeq: clientLastSeq });

  while (queuedClientMessages.length > 0 && runnerSocket.readyState === WebSocket.OPEN) {
    const raw = queuedClientMessages.shift();
    if (!raw) continue;
    logBridge('flushing_queued_client_message', {
      remainingQueueLength: queuedClientMessages.length,
    });
    await handleClientMessage(raw);
  }
}

export async function buildRunnerUserMessageContent(
  env: RouteContext['env'],
  workspaceId: string,
  rawContent: string,
  author?: ChatAuthorIdentity | null,
): Promise<string> {
  const safeContent = injectFileSafetyMessage(rawContent);
  let contentWithConnectionContext = safeContent;

  if (safeContent.includes('@')) {
    try {
      const workspaceStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
      const integrations = await workspaceStub.getIntegrations();
      contentWithConnectionContext = applyConnectionMentionContext(
        safeContent,
        integrations,
      ).content;
    } catch (error) {
      console.error('[chat websocket] apply connection mentions failed', error);
    }
  }

  return formatAttributedUserMessage(contentWithConnectionContext, author);
}

async function updateThreadMetadataForUserMessage(
  env: RouteContext['env'],
  orgId: string,
  workspaceId: string,
  threadId: string,
  userId: string,
  messageContent: string,
): Promise<void> {
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const thread = await orgStub.getThread(threadId);
  if (!thread) return;

  await orgStub.touchThread(threadId);
  const userStub = env.USER.get(env.USER.idFromName(userId));
  await userStub.touchGroupForThread(threadId);

  const titleSourceMessage = getThreadTitleSourceMessage(messageContent);
  if (!titleSourceMessage) return;

  const hasFirstUserMessage =
    typeof thread.first_user_message === 'string' &&
    thread.first_user_message.trim().length > 0;
  if (hasFirstUserMessage) return;

  await orgStub.setThreadFirstUserMessage(threadId, titleSourceMessage);

  if (!isPlaceholderThreadTitle(thread.title)) return;

  try {
    const title = await generateThreadTitleWithOpenAI(env, titleSourceMessage, {
      orgId,
      workspaceId,
      threadId,
    });
    if (title) {
      await orgStub.updateThread(threadId, title);
      await userStub.renameEmptySingleThreadGroupForThread(threadId, title);
      await getThreadStub(env, threadId).setTitle(title);
    }
  } catch (error) {
    console.error('[chat websocket] failed to generate thread title', error);
  }
}

async function recordThreadAssistantCompletion(
  env: RouteContext['env'],
  orgId: string,
  workspaceId: string,
  threadId: string,
  completedAt: number,
): Promise<void> {
  try {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
      touchThreadActivity(id: string, at?: number): Promise<boolean> | boolean;
    };
    await orgStub.touchThreadActivity(threadId, completedAt);
  } catch (error) {
    console.error('[chat websocket] failed to touch thread activity', error);
  }

  await recordWorkspaceThreadStreaming(
    env,
    workspaceId,
    threadId,
    false,
    { completedAt },
  );
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

function normalizeCompletionTimestamp(_value: unknown): number {
  return Date.now();
}

function normalizeCompletionTimestampOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Date.now();
}
