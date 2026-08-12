/**
 * ChatThreadDO chat transport over HTTP: SSE receive (`GET .../sse`) + POST send
 * (`POST .../call`).
 *
 * The transport is an ADAPTER, not a reimplementation: the SSE attach drives the
 * existing wrapped onConnect chain and the POST endpoint drives the existing
 * wrapped onMessage chain, so what these tests pin is the seam — frame order on
 * attach, the frame allow-list at the HTTP boundary, rpc capture without a live
 * stream, the resume handshake split across POST (request/ack) and SSE (reply +
 * replay), teardown running the full onClose chain, and the idle-close policy.
 */

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

type AnyRecord = Record<string, unknown>;

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

function attachUrl(
  threadId: string,
  options: { pk: string; orgId?: string | null },
): string {
  const url = new URL(`http://internal/agents/chat-thread/${threadId}/sse`);
  url.searchParams.set('threadId', threadId);
  url.searchParams.set('workspaceId', 'workspace-1');
  if (options.orgId !== null) url.searchParams.set('orgId', options.orgId ?? 'org-1');
  url.searchParams.set('_pk', options.pk);
  return url.toString();
}

function callUrl(threadId: string, pk: string): string {
  const url = new URL(`http://internal/agents/chat-thread/${threadId}/call`);
  url.searchParams.set('threadId', threadId);
  url.searchParams.set('workspaceId', 'workspace-1');
  url.searchParams.set('orgId', 'org-1');
  url.searchParams.set('_pk', pk);
  return url.toString();
}

const identityHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'X-Chiridion-User-Id': 'user-1',
  'X-Chiridion-User-Name': 'User One',
  'X-Chiridion-User-Email': 'user-1@example.com',
  ...extra,
});

/** Minimal SSE parser: yields data frames and `bye` events, skipping heartbeats. */
function sseReader(response: Response) {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let raw = '';

  const nextBlock = async (): Promise<{ event: string | null; data: string } | null> => {
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary >= 0) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let event: string | null = null;
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
          else if (line.startsWith('event: ')) event = line.slice('event: '.length);
        }
        if (data.length === 0 && event === null) continue;
        return { event, data: data.join('\n') };
      }
      const { value, done } = await reader.read();
      if (done) return null;
      const text = decoder.decode(value, { stream: true });
      raw += text;
      buffer += text;
    }
  };

  return {
    rawText: () => raw,
    nextBlock,
    async collectUntil(
      isDone: (frames: AnyRecord[]) => boolean,
      max = 12,
    ): Promise<AnyRecord[]> {
      const frames: AnyRecord[] = [];
      while (frames.length < max && !isDone(frames)) {
        const block = await nextBlock();
        if (!block) break;
        if (block.event === 'bye') {
          frames.push({ type: 'bye', ...(JSON.parse(block.data) as AnyRecord) });
          break;
        }
        frames.push(JSON.parse(block.data) as AnyRecord);
      }
      return frames;
    },
    cancel: () => reader.cancel(),
  };
}

const frameTypes = (frames: AnyRecord[]): string[] =>
  frames.map((frame) => String(frame.type));

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await scheduler.wait(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const seedChatContext = (instance: any, threadId: string, orgId = 'org-1') => {
  instance.chatContext = {
    threadId,
    workspaceId: 'workspace-1',
    orgId,
    userId: 'user-1',
    userName: 'User One',
    userEmail: 'user-1@example.com',
  };
};

describe('ChatThreadDO SSE attach', () => {
  it('serves the wrapped connect chain in socket frame order', async () => {
    const threadId = 'thread-sse-attach-order';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      await instance.persistMessages([
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi', state: 'done' }] },
        { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'yo', state: 'done' }] },
      ]);
    });

    const response = await stub.fetch(attachUrl(threadId, { pk: 'pk-order' }), {
      headers: identityHeaders({ Accept: 'text/event-stream' }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');

    const reader = sseReader(response);
    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).includes('cf_agent_chat_messages'),
    );
    const types = frameTypes(frames);

    // Agent's connect wrapper first (identity → state → mcp), then the app's
    // resident render history — the exact order a socket sees today.
    expect(types.indexOf('cf_agent_identity')).toBe(0);
    expect(types.indexOf('cf_agent_state')).toBeGreaterThan(
      types.indexOf('cf_agent_identity'),
    );
    expect(types.indexOf('cf_agent_mcp_servers')).toBeGreaterThan(
      types.indexOf('cf_agent_state'),
    );
    expect(types.indexOf('cf_agent_chat_messages')).toBeGreaterThan(
      types.indexOf('cf_agent_mcp_servers'),
    );
    const history = frames.find((frame) => frame.type === 'cf_agent_chat_messages');
    expect((history?.messages as AnyRecord[]).map((message) => message.id)).toEqual([
      'u1',
      'a1',
    ]);

    await reader.cancel();
  });

  it('registers the stream under the client-minted _pk', async () => {
    const threadId = 'thread-sse-registry';
    const stub = threadStub(threadId);
    const response = await stub.fetch(attachUrl(threadId, { pk: 'pk-registry' }), {
      headers: identityHeaders(),
    });
    expect(response.status).toBe(200);

    await runInDurableObject(stub, async (instance: any) => {
      const registered = instance.sseConnections.get('pk-registry');
      expect(registered).toBeDefined();
      expect(registered.id).toBe('pk-registry');
      expect(Array.from(instance.getConnections()).some(
        (connection: any) => connection.id === 'pk-registry',
      )).toBe(true);
      expect(instance.getConnection('pk-registry')?.id).toBe('pk-registry');
    });

    await response.body?.cancel();
  });

  it('403s an org mismatch before the stream body starts', async () => {
    const threadId = 'thread-sse-org-mismatch';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId, 'org-1');
    });

    const response = await stub.fetch(
      attachUrl(threadId, { pk: 'pk-mismatch', orgId: 'org-2' }),
      { headers: identityHeaders() },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get('content-type')).not.toBe('text/event-stream');
  });

  it('503s a degraded attach with no prior grant, and admits one with a grant', async () => {
    const threadId = 'thread-sse-degraded';
    const stub = threadStub(threadId);

    const denied = await stub.fetch(attachUrl(threadId, { pk: 'pk-degraded-1' }), {
      headers: identityHeaders({ 'X-Chiridion-Auth-Degraded': '1' }),
    });
    expect(denied.status).toBe(503);

    // A full attach mints the grant and stores the chat context the degraded
    // admit checks against.
    const full = await stub.fetch(attachUrl(threadId, { pk: 'pk-degraded-2' }), {
      headers: identityHeaders(),
    });
    expect(full.status).toBe(200);
    await waitFor(
      () =>
        runInDurableObject(stub, (instance: any) => Boolean(instance.chatContext)),
      'chat context capture',
    );
    await full.body?.cancel();

    const admitted = await stub.fetch(attachUrl(threadId, { pk: 'pk-degraded-3' }), {
      headers: identityHeaders({ 'X-Chiridion-Auth-Degraded': '1' }),
    });
    expect(admitted.status).toBe(200);
    await admitted.body?.cancel();
  });

  it('retires a stale shim when a reattach reuses the same _pk', async () => {
    const threadId = 'thread-sse-reattach';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-reattach');
      await instance._storeStreamChunk(streamId, JSON.stringify({ type: 'text-delta', delta: 'x' }));
      instance._flushChunkBuffer();
    });

    const first = await stub.fetch(attachUrl(threadId, { pk: 'pk-same' }), {
      headers: identityHeaders(),
    });
    expect(first.status).toBe(200);
    const firstReader = sseReader(first);
    await firstReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );

    const second = await stub.fetch(attachUrl(threadId, { pk: 'pk-same' }), {
      headers: identityHeaders(),
    });
    expect(second.status).toBe(200);
    const secondReader = sseReader(second);
    await secondReader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.sseConnections.size).toBe(1);
      expect(instance.sseConnections.get('pk-same').isOpen).toBe(true);
      // The retired shim's onClose cleanup is keyed by the id this attach
      // reuses; if it ran late it would wipe the live stream's pending-resume
      // registration and the replay would interleave with live frames.
      expect(instance._pendingResumeConnections.has('pk-same')).toBe(true);
    });

    await firstReader.cancel();
    await secondReader.cancel();
  });
});

describe('ChatThreadDO POST /call', () => {
  it('captures the rpc response in the POST body', async () => {
    const threadId = 'thread-call-rpc';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
    });

    const response = await stub.fetch(callUrl(threadId, 'pk-rpc'), {
      method: 'POST',
      headers: identityHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-1',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });

    expect(response.status).toBe(200);
    const frame = (await response.json()) as AnyRecord;
    expect(frame).toMatchObject({ type: 'rpc', id: 'call-1', success: true, done: true });
  });

  it('returns the rpc failure frame instead of an HTTP error', async () => {
    const threadId = 'thread-call-rpc-error';
    const stub = threadStub(threadId);

    const response = await stub.fetch(callUrl(threadId, 'pk-rpc-error'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-2',
        method: 'getOlderUiMessages',
        args: [''],
      }),
    });

    expect(response.status).toBe(200);
    const frame = (await response.json()) as AnyRecord;
    expect(frame).toMatchObject({ type: 'rpc', id: 'call-2', success: false });
    expect(String(frame.error)).toContain('cursor');
  });

  it('acks a duplicate clientMessageId without enqueueing a second turn', async () => {
    const threadId = 'thread-call-dedupe';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      instance.recordAcceptedClientMessageId('client-msg-1');
      instance.enqueueRunnerUserMessage = () => {
        throw new Error('must not enqueue a duplicate send');
      };
    });

    const response = await stub.fetch(callUrl(threadId, 'pk-dedupe'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-3',
        method: 'sendMessage',
        args: ['hello again', 'client-msg-1'],
      }),
    });

    const frame = (await response.json()) as AnyRecord;
    expect(frame).toMatchObject({ type: 'rpc', id: 'call-3', success: true });
    expect(frame.result).toMatchObject({ status: 'accepted' });
  });

  it('bootstraps chat context on a first POST, then leaves identity alone', async () => {
    const threadId = 'thread-call-bootstrap';
    const stub = threadStub(threadId);

    const first = await stub.fetch(callUrl(threadId, 'pk-bootstrap'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-boot-1',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });
    expect(first.status).toBe(200);
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.chatContext).toMatchObject({
        threadId,
        workspaceId: 'workspace-1',
        orgId: 'org-1',
        userId: 'user-1',
      });
    });

    // A second poster must not rewrite the thread's shared identity context.
    await stub.fetch(callUrl(threadId, 'pk-bootstrap'), {
      method: 'POST',
      headers: identityHeaders({ 'X-Chiridion-User-Id': 'user-2' }),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-boot-2',
        method: 'setPreviewTabsState',
        args: [[], null],
      }),
    });
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.chatContext.userId).toBe('user-1');
    });
  });

  it('rejects an rpc method outside the callable allow-list', async () => {
    const threadId = 'thread-call-method-guard';
    const stub = threadStub(threadId);

    const response = await stub.fetch(callUrl(threadId, 'pk-method'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({
        type: 'rpc',
        id: 'call-4',
        method: 'persistMessages',
        args: [[]],
      }),
    });

    expect(response.status).toBe(400);
  });

  it('rejects non-frame and unsupported payloads', async () => {
    const threadId = 'thread-call-payload-guard';
    const stub = threadStub(threadId);

    for (const body of ['not json', JSON.stringify({ type: 'bogus_type' }), JSON.stringify({})]) {
      const response = await stub.fetch(callUrl(threadId, 'pk-payload'), {
        method: 'POST',
        headers: identityHeaders(),
        body,
      });
      expect(response.status).toBe(400);
    }
  });

  it('409s a resume frame when no live stream is registered', async () => {
    const threadId = 'thread-call-resume-409';
    const stub = threadStub(threadId);

    const response = await stub.fetch(callUrl(threadId, 'pk-missing'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'probe-1' }),
    });

    expect(response.status).toBe(409);
  });

  it('dispatches a resume request against the live stream shim', async () => {
    const threadId = 'thread-call-resume-live';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-resume' }), {
      headers: identityHeaders(),
    });
    expect(attached.status).toBe(200);
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    const acked = await stub.fetch(callUrl(threadId, 'pk-resume'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_request', probeId: 'probe-2' }),
    });
    expect(acked.status).toBe(204);

    // The handshake reply rides the SSE stream, not the POST response.
    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).some((type) => type.startsWith('cf_agent_stream_')),
    );
    expect(
      frameTypes(frames).some((type) => type.startsWith('cf_agent_stream_')),
    ).toBe(true);

    await reader.cancel();
  });

  it('replays an active stream over SSE after an ack posted mid-stream', async () => {
    const threadId = 'thread-call-resume-replay';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-1');
      await instance._storeStreamChunk(
        streamId,
        JSON.stringify({ type: 'text-delta', delta: 'partial', id: 'part-1' }),
      );
      instance._flushChunkBuffer();
    });

    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-replay' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    const connectFrames = await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );
    const resuming = connectFrames.find(
      (frame) => frame.type === 'cf_agent_stream_resuming',
    );
    expect(resuming).toMatchObject({ id: 'request-1' });

    const acked = await stub.fetch(callUrl(threadId, 'pk-replay'), {
      method: 'POST',
      headers: identityHeaders(),
      body: JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'request-1' }),
    });
    expect(acked.status).toBe(204);

    const replayFrames = await reader.collectUntil((frames) =>
      frames.some((frame) => frame.type === 'cf_agent_use_chat_response' && frame.replay),
    );
    const replayed = replayFrames.filter(
      (frame) => frame.type === 'cf_agent_use_chat_response' && frame.replay,
    );
    expect(replayed.length).toBeGreaterThan(0);
    expect(String(replayed[0]!.body)).toContain('partial');

    await runInDurableObject(stub, async (instance: any) => {
      // The ack un-suppresses live broadcast for this connection.
      expect(instance._pendingResumeConnections.has('pk-replay')).toBe(false);
    });

    await reader.cancel();
  });
});

describe('ChatThreadDO SSE lifecycle', () => {
  it('runs the full onClose chain when the stream is torn down', async () => {
    const threadId = 'thread-sse-teardown';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const streamId = instance._startStream('request-teardown');
      await instance._storeStreamChunk(streamId, JSON.stringify({ type: 'text-delta', delta: 'x' }));
      instance._flushChunkBuffer();
    });

    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-teardown' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_stream_resuming'),
    );
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance._pendingResumeConnections.has('pk-teardown')).toBe(true);
    });

    // What a stream cancel / request abort / failed heartbeat write all funnel
    // into. The framework's onClose wrapper is the only cleanup for
    // _pendingResumeConnections, so a teardown that skips it leaves this id
    // excluded from every later chat broadcast.
    await runInDurableObject(stub, async (instance: any) => {
      instance.sseConnections.get('pk-teardown').abort(1006, 'stream_closed');
      expect(instance.sseConnections.size).toBe(0);
    });

    await waitFor(
      () =>
        runInDurableObject(
          stub,
          (instance: any) => !instance._pendingResumeConnections.has('pk-teardown'),
        ),
      'onClose resume-state cleanup',
    );

    await reader.cancel();
  });

  it('closes an idle stream with bye {"reason":"idle"}', async () => {
    const threadId = 'thread-sse-idle';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-idle' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.hasLiveChatWorkForStream()).toBe(false);
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(0);
    });

    const frames = await reader.collectUntil((collected) =>
      frameTypes(collected).includes('bye'),
    );
    expect(frames.at(-1)).toMatchObject({ type: 'bye', reason: 'idle' });
  });

  it('holds an idle-grace stream open while the thread has work', async () => {
    const threadId = 'thread-sse-hold';
    const stub = threadStub(threadId);
    const attached = await stub.fetch(attachUrl(threadId, { pk: 'pk-hold' }), {
      headers: identityHeaders(),
    });
    const reader = sseReader(attached);
    await reader.collectUntil((frames) =>
      frameTypes(frames).includes('cf_agent_mcp_servers'),
    );

    await runInDurableObject(stub, async (instance: any) => {
      instance.isThreadStreaming = () => true;
      instance.sseIdleSince = Date.now() - 10 * 60 * 1000;
      instance.sweepSseConnections();
      expect(instance.sseConnections.size).toBe(1);
      expect(instance.sseIdleSince).toBeNull();
    });

    await reader.cancel();
  });
});
