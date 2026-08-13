/**
 * Wake-OOM containment for the resumable-stream replay buffer
 * (plans/sse-migration/OOM-FIX.md).
 *
 * Three bounds are pinned here: transient chunks never reach the buffer, one
 * stream's stored bytes are capped (and a capped stream resumes by attaching to
 * live rather than replaying a truncated turn), and a replay read is paged
 * instead of materializing the whole buffer — byte-identically to the SDK's own
 * frames, which the batched loop is compared against directly. Plus the wake
 * circuit breaker that quarantines the buffers of a thread that cannot finish a
 * wake at all.
 */

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import {
  SseConnection,
  createSseCaptureConnection,
} from '../src/chat-thread/sse-connection';

type AnyRecord = Record<string, unknown>;

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

/**
 * Production installs the bounded replay in onStart; `runInDurableObject` hands
 * back an instance without going through partyserver's initialization, so the
 * tests that call `replayChunks` directly install it the same way onStart does.
 * That onStart really does it is asserted in the wake-circuit-breaker block.
 */
const installBoundedReplay = (instance: any) => instance.installBoundedStreamReplay();

const seedChatContext = (instance: any, threadId: string) => {
  instance.chatContext = {
    threadId,
    workspaceId: 'workspace-1',
    orgId: 'org-1',
    userId: 'user-1',
    userName: 'User One',
    userEmail: 'user-1@example.com',
  };
};

/** Collect the observability events a call records, without the env round trip. */
function captureObservabilityEvents(instance: any): Array<{ event: string; details: AnyRecord }> {
  const recorded: Array<{ event: string; details: AnyRecord }> = [];
  instance.recordChatThreadObservabilityEvent = (event: string, details: AnyRecord = {}) => {
    recorded.push({ event, details });
  };
  return recorded;
}

const captureConnection = (id: string) =>
  createSseCaptureConnection({ id, uri: null, server: 'thread' });

/** A peer that is gone: `SseConnection.send` reports it as the SDK's closed-send
 *  TypeError, which is what makes a replay loop abort mid-way. */
const deadConnection = (id: string) =>
  new SseConnection({
    id,
    uri: null,
    server: 'thread',
    sink: {
      onDead: null,
      send: () => false,
      comment: () => true,
      bye: () => {},
      stalledFor: () => 0,
      close: () => {},
    },
    onTeardown: () => {},
  });

const storedChunkCount = (instance: any, streamId: string): number => {
  const [row] = instance.ctx.storage.sql
    .exec('select count(*) as n from cf_ai_chat_stream_chunks where stream_id = ?', streamId)
    .toArray() as Array<{ n: number }>;
  return row?.n ?? 0;
};

const storedChunkBytes = (instance: any, streamId: string): number => {
  const [row] = instance.ctx.storage.sql
    .exec(
      'select sum(length(cast(body as blob))) as bytes from cf_ai_chat_stream_chunks where stream_id = ?',
      streamId,
    )
    .toArray() as Array<{ bytes: number | null }>;
  return row?.bytes ?? 0;
};

describe('resumable-stream chunk storage bounds', () => {
  it('broadcasts transient chunks without storing them', async () => {
    const threadId = 'thread-replay-transient';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const broadcast: string[] = [];
      instance.broadcast = (message: string) => broadcast.push(message);

      const streamId = instance._startStream('request-transient');
      // The SDK's own store+broadcast funnel: storing is skipped, broadcasting
      // is not (the client applies the live tail and then forgets it).
      await instance._broadcastTextEvent(
        streamId,
        { type: 'data-pi-tool-stream', transient: true, id: 'tool-1', data: { text: 'tail' } },
        false,
      );
      await instance._broadcastTextEvent(
        streamId,
        { type: 'data-pi-heartbeat', transient: true, id: 'hb-1', data: { at: 1 } },
        false,
      );
      await instance._broadcastTextEvent(
        streamId,
        { type: 'text-delta', id: 'part-1', delta: 'kept' },
        false,
      );
      instance._flushChunkBuffer();

      expect(broadcast.length).toBe(3);
      expect(broadcast.some((frame) => frame.includes('data-pi-tool-stream'))).toBe(true);
      expect(broadcast.some((frame) => frame.includes('data-pi-heartbeat'))).toBe(true);

      const rows = instance.ctx.storage.sql
        .exec('select body from cf_ai_chat_stream_chunks where stream_id = ?', streamId)
        .toArray() as Array<{ body: string }>;
      expect(rows.length).toBe(1);
      expect(rows[0]!.body).toContain('kept');
      expect(rows[0]!.body).not.toContain('transient');
    });
  });

  it('stops storing past the per-stream byte ceiling', async () => {
    const threadId = 'thread-replay-cap';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      instance._streamReplayMaxStoredBytesOverride = 4_000;

      const streamId = instance._startStream('request-cap');
      const delta = 'x'.repeat(1_000);
      for (let i = 0; i < 20; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta }),
        );
        instance._flushChunkBuffer();
      }

      const bytes = storedChunkBytes(instance, streamId);
      expect(bytes).toBeGreaterThan(0);
      // The chunk that crosses the ceiling is stored whole; nothing after it is.
      expect(bytes).toBeLessThan(4_000 + 1_200);
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(events.filter((entry) => entry.event === 'chat_stream_replay_degraded').length).toBe(1);
    });
  });

  it('replays nothing but the terminator for a degraded live stream', async () => {
    const threadId = 'thread-replay-degraded-live';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 1_000;

      const streamId = instance._startStream('request-degraded-live');
      for (let i = 0; i < 5; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(600) }),
        );
        instance._flushChunkBuffer();
      }
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      expect(storedChunkCount(instance, streamId)).toBeGreaterThan(0);

      const { connection, frames } = captureConnection('capture-degraded-live');
      expect(instance._resumableStream.replayChunks(connection, 'request-degraded-live')).toBe(
        null,
      );
      // Attach to live: the CHAT_MESSAGES snapshot and the turn-end persist are
      // what close the gap, not a truncated replay.
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: false,
          id: 'request-degraded-live',
          type: 'cf_agent_use_chat_response',
          replay: true,
          replayComplete: true,
        },
      ]);
      // The stream stays live and active — nothing about a resume ends the turn.
      expect(instance._resumableStream.hasActiveStream()).toBe(true);
    });
  });

  it('re-detects a degraded stream adopted by restore', async () => {
    const threadId = 'thread-replay-restore-degraded';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 4_000;

      // What an eviction leaves behind: a `streaming` metadata row plus an
      // over-ceiling buffer, and no in-memory byte bookkeeping at all.
      const streamId = 'stream-restored-degraded';
      instance.ctx.storage.sql.exec(
        'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
          ' values (?, ?, ?, ?, ?, ?)',
        streamId,
        'request-restored',
        'streaming',
        Date.now(),
        null,
        0,
      );
      const body = JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'y'.repeat(1_000) });
      for (let index = 0; index < 10; index++) {
        instance.ctx.storage.sql.exec(
          'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
          `chunk-${index}`,
          streamId,
          body,
          index,
          Date.now(),
        );
      }
      instance._streamStoredBytes?.clear();
      instance._replayDegradedStreams?.clear();
      instance._restoreActiveStream();
      expect(instance._resumableStream.activeStreamId).toBe(streamId);

      const events = captureObservabilityEvents(instance);
      const { connection, frames } = captureConnection('capture-restored');
      // A restored stream has no live reader, so this is the orphan branch: no
      // chunk replay (degraded), then the SDK's `done` + finalization.
      expect(instance._resumableStream.replayChunks(connection, 'request-restored')).toBe(streamId);
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: true,
          id: 'request-restored',
          type: 'cf_agent_use_chat_response',
          replay: true,
        },
      ]);
      expect(events.filter((entry) => entry.event === 'chat_stream_replay_degraded').length).toBe(1);
    });
  });

  it('finalizes an orphaned degraded stream with a done frame', async () => {
    const threadId = 'thread-replay-orphan-degraded';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 1_000;

      const streamId = instance._startStream('request-orphan-degraded');
      for (let i = 0; i < 5; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(600) }),
        );
        instance._flushChunkBuffer();
      }
      expect(instance._isStreamReplayDegraded(streamId)).toBe(true);
      // A stream restored from SQLite has no live reader.
      instance._resumableStream._isLive = false;

      const { connection, frames } = captureConnection('capture-orphan');
      expect(
        instance._resumableStream.replayChunks(connection, 'request-orphan-degraded'),
      ).toBe(streamId);
      expect(frames.map((frame) => JSON.parse(frame) as AnyRecord)).toEqual([
        {
          body: '',
          done: true,
          id: 'request-orphan-degraded',
          type: 'cf_agent_use_chat_response',
          replay: true,
        },
      ]);
      // Completed exactly as the SDK would, so the caller persists the partial.
      expect(instance._resumableStream.hasActiveStream()).toBe(false);
    });
  });
});

describe('batched replay', () => {
  it('emits frames byte-identical to the SDK across many batches', async () => {
    const threadId = 'thread-replay-batched';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-batched');
      // ~100 segment rows — several pages' worth — as a mix of packed
      // multi-chunk segments and single-chunk rows, so unpacking is exercised in
      // both row shapes.
      const chunkCount = 150;
      for (let index = 0; index < chunkCount; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        if (index % 3 !== 1) instance._flushChunkBuffer();
      }
      instance._flushChunkBuffer();
      const rowCount = storedChunkCount(instance, streamId);
      expect(rowCount).toBeGreaterThan(40);

      const stream = instance._resumableStream;
      const batched = captureConnection('capture-batched');
      const unbatched = captureConnection('capture-unbatched');
      // The wrap is installed on the INSTANCE, so the prototype still holds the
      // SDK's original single-query implementation to compare against.
      const sdkReplayChunks = Object.getPrototypeOf(stream).replayChunks;

      expect(stream.replayChunks(batched.connection, 'request-batched')).toBe(null);
      expect(sdkReplayChunks.call(stream, unbatched.connection, 'request-batched')).toBe(null);

      expect(batched.frames).toEqual(unbatched.frames);
      expect(batched.frames.length).toBe(chunkCount + 1);
      expect(JSON.parse(batched.frames[0]!)).toEqual({
        body: JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'chunk-0' }),
        done: false,
        id: 'request-batched',
        type: 'cf_agent_use_chat_response',
        replay: true,
      });
      expect(JSON.parse(batched.frames.at(-1)!)).toMatchObject({ replayComplete: true });
    });
  });

  it('does not replay segments flushed after the replay started', async () => {
    const threadId = 'thread-replay-snapshot';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-snapshot');
      const chunkCount = 90;
      for (let index = 0; index < chunkCount; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        instance._flushChunkBuffer();
      }

      // A still-live stream keeps flushing while the replay is paged out. The
      // SDK's single query never saw those rows — the client receives them as
      // live broadcasts — so paging must not pick them up either, or the text
      // arrives twice.
      const { connection, frames } = captureConnection('capture-snapshot');
      const capturedSend = connection.send.bind(connection);
      let sent = 0;
      (connection as any).send = (message: string) => {
        capturedSend(message);
        if (++sent !== 45) return;
        instance.ctx.storage.sql.exec(
          'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
          'chunk-late',
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'late' }),
          chunkCount,
          Date.now(),
        );
      };

      expect(instance._resumableStream.replayChunks(connection, 'request-snapshot')).toBe(null);
      expect(frames.length).toBe(chunkCount + 1);
      expect(frames.some((frame) => frame.includes('late'))).toBe(false);
    });
  });

  it('is what the resume handshake drives', async () => {
    const threadId = 'thread-replay-handshake';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      instance._streamReplayMaxStoredBytesOverride = 1_000;
      const streamId = instance._startStream('request-handshake');
      for (let i = 0; i < 5; i++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'z'.repeat(600) }),
        );
        instance._flushChunkBuffer();
      }

      // The framework's resume-ack path, i.e. what a reconnecting client
      // actually triggers — not a direct call to the replaced method.
      const { connection, frames } = captureConnection('capture-handshake');
      await instance.onMessage(
        connection,
        JSON.stringify({ type: 'cf_agent_stream_resume_ack', id: 'request-handshake' }),
      );

      const replayFrames = frames
        .map((frame) => JSON.parse(frame) as AnyRecord)
        .filter((frame) => frame.type === 'cf_agent_use_chat_response');
      expect(replayFrames).toEqual([
        {
          body: '',
          done: false,
          id: 'request-handshake',
          type: 'cf_agent_use_chat_response',
          replay: true,
          replayComplete: true,
        },
      ]);
    });
  });

  it('marks continuation replays exactly as the SDK does', async () => {
    const threadId = 'thread-replay-continuation';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-continuation', { continuation: true });
      await instance._storeStreamChunk(
        streamId,
        JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'partial' }),
      );
      instance._flushChunkBuffer();

      const stream = instance._resumableStream;
      const batched = captureConnection('capture-continuation-batched');
      const unbatched = captureConnection('capture-continuation-sdk');
      expect(stream.replayChunks(batched.connection, 'request-continuation')).toBe(null);
      expect(
        Object.getPrototypeOf(stream).replayChunks.call(
          stream,
          unbatched.connection,
          'request-continuation',
        ),
      ).toBe(null);

      expect(batched.frames).toEqual(unbatched.frames);
      expect(JSON.parse(batched.frames[0]!)).toMatchObject({ continuation: true, replay: true });
    });
  });

  it('aborts on a dead sink mid-batch and leaves the stream active', async () => {
    const threadId = 'thread-replay-dead-sink';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      installBoundedReplay(instance);
      const streamId = instance._startStream('request-dead');
      for (let index = 0; index < 60; index++) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({ type: 'text-delta', id: 'part-1', delta: `chunk-${index}` }),
        );
        instance._flushChunkBuffer();
      }
      // An orphaned stream is the case where bailing matters: completing it on a
      // replay nobody received would lose the buffer for the next reattach.
      instance._resumableStream._isLive = false;

      expect(
        instance._resumableStream.replayChunks(deadConnection('dead-replay'), 'request-dead'),
      ).toBe(null);
      expect(instance._resumableStream.activeStreamId).toBe(streamId);
      const [metadata] = instance.ctx.storage.sql
        .exec('select status from cf_ai_chat_stream_metadata where id = ?', streamId)
        .toArray() as Array<{ status: string }>;
      expect(metadata?.status).toBe('streaming');
    });
  });
});

describe('wake circuit breaker', () => {
  const seedStreamBuffer = (instance: any, streamId: string) => {
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
        ' values (?, ?, ?, ?, ?, ?)',
      streamId,
      `request-${streamId}`,
      'streaming',
      Date.now(),
      null,
      0,
    );
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
      `chunk-${streamId}`,
      streamId,
      JSON.stringify({ type: 'text-delta', id: 'part-1', delta: 'partial' }),
      0,
      Date.now(),
    );
  };

  const streamRowCounts = (instance: any): { chunks: number; metadata: number } => {
    const [chunks] = instance.ctx.storage.sql
      .exec('select count(*) as n from cf_ai_chat_stream_chunks')
      .toArray() as Array<{ n: number }>;
    const [metadata] = instance.ctx.storage.sql
      .exec('select count(*) as n from cf_ai_chat_stream_metadata')
      .toArray() as Array<{ n: number }>;
    return { chunks: chunks?.n ?? 0, metadata: metadata?.n ?? 0 };
  };

  it('quarantines the stream buffers on the third failed wake', async () => {
    const threadId = 'thread-wake-quarantine';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-quarantined');
      instance.ctx.storage.kv.put('wakeOomGuard', { count: 2, at: Date.now() });
      instance.ctx.storage.kv.put('cf:chat:recovering', { at: Date.now(), requestId: 'r-1' });

      await instance.onStart();

      expect(streamRowCounts(instance)).toEqual({ chunks: 0, metadata: 0 });
      expect(instance._resumableStream.hasActiveStream()).toBe(false);
      expect(instance.ctx.storage.kv.get('cf:chat:recovering')).toBe(undefined);
      const quarantine = events.filter((entry) => entry.event === 'chat_do_wake_quarantine');
      expect(quarantine.length).toBe(1);
      expect(quarantine[0]!.details).toMatchObject({ severity: 'error', count: 3 });
      // A wake that completed says nothing about the next one.
      expect(instance.ctx.storage.kv.get('wakeOomGuard')).toMatchObject({ count: 0 });
    });
  });

  it('leaves the stream buffers alone on a healthy wake', async () => {
    const threadId = 'thread-wake-healthy';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-kept');
      instance.ctx.storage.kv.delete('wakeOomGuard');

      await instance.onStart();

      expect(streamRowCounts(instance)).toEqual({ chunks: 1, metadata: 1 });
      expect(events.some((entry) => entry.event === 'chat_do_wake_quarantine')).toBe(false);
      expect(instance.ctx.storage.kv.get('wakeOomGuard')).toMatchObject({ count: 0 });
      // Every wake also (re)installs the bounded replay before super.onStart's
      // buffer reads can run.
      expect(instance.boundedReplayStream).toBe(instance._resumableStream);
    });
  });

  it('ignores a count from outside the rolling window', async () => {
    const threadId = 'thread-wake-stale';
    const stub = threadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      seedChatContext(instance, threadId);
      const events = captureObservabilityEvents(instance);
      seedStreamBuffer(instance, 'stream-stale-guard');
      instance.ctx.storage.kv.put('wakeOomGuard', {
        count: 9,
        at: Date.now() - 2 * 60 * 60 * 1000,
      });

      // The guard write happens before any heavy work, so the count it wrote is
      // observable even though this wake goes on to succeed and reset it.
      const armed: Array<number | undefined> = [];
      const originalInstall = instance.installBoundedStreamReplay.bind(instance);
      instance.installBoundedStreamReplay = () => {
        armed.push(
          (instance.ctx.storage.kv.get('wakeOomGuard') as { count?: number } | undefined)?.count,
        );
        originalInstall();
      };

      await instance.onStart();

      expect(armed).toEqual([1]);
      expect(streamRowCounts(instance)).toEqual({ chunks: 1, metadata: 1 });
      expect(events.some((entry) => entry.event === 'chat_do_wake_quarantine')).toBe(false);
    });
  });
});
