import { env, runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ChatThreadDO } from '../src/chat-thread-do';
import * as memoryTelemetry from '../src/chat-thread/chat-memory-telemetry';
import { collectChatMemoryStats } from '../src/chat-thread/chat-memory-telemetry';

async function newChatThreadStub(threadId: string) {
  const id = (env as any).CHAT_THREAD.idFromName(threadId);
  return (env as any).CHAT_THREAD.get(id);
}

describe('privacy-safe chat memory aggregates', () => {
  it('counts UTF-8 serialized bytes, rows, and largest rows without reading payloads', async () => {
    const stub = await newChatThreadStub('thread-memory-aggregate');
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      instance.ensurePiCoreTables();
      sql.exec('DELETE FROM cf_ai_chat_agent_messages');
      sql.exec('DELETE FROM pi_core_messages');
      sql.exec('DELETE FROM pi_turn_journal');
      // NOTE: this test previously CREATED cf_ai_chat_stream_chunks itself, which
      // is why the telemetry pointing at that table went unnoticed — the table
      // exists in neither @cloudflare/ai-chat nor agents, so in production that
      // store reported 0 forever. Measure a table that really exists.
      sql.exec(
        `CREATE TABLE IF NOT EXISTS cf_ai_chat_agent_tool_runs (
           run_id text primary key, request_id text, status text not null,
           input_json text, output_json text, summary text, error_message text,
           started_at integer not null)`,
      );
      sql.exec('DELETE FROM cf_ai_chat_agent_tool_runs');

      sql.exec(
        'INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)',
        'r1',
        'é', // two UTF-8 bytes, proving this is not JS/string character length
      );
      sql.exec(
        'INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)',
        0,
        '12345',
        1,
      );
      sql.exec(
        'INSERT INTO pi_turn_journal (seq, payload, created_at) VALUES (?, ?, ?)',
        0,
        'abc',
        1,
      );
      sql.exec(
        `INSERT INTO cf_ai_chat_agent_tool_runs
          (run_id, status, output_json, started_at) VALUES (?, ?, ?, ?)`,
        'run1',
        'complete',
        '1234567',
        1,
      );

      const stats = collectChatMemoryStats(sql);
      expect(stats.stores).toEqual({
        render: { rows: 1, bytes: 2, maxRowBytes: 2, measured: true },
        pi: { rows: 1, bytes: 5, maxRowBytes: 5, measured: true },
        journal: { rows: 1, bytes: 3, maxRowBytes: 3, measured: true },
        toolRuns: { rows: 1, bytes: 7, maxRowBytes: 7, measured: true },
      });
      expect(stats).toMatchObject({
        totalRows: 4,
        totalBytes: 17,
        maxRowBytes: 7,
      });
    });
  });

  it('uses aggregate-only SQL with byte-length accounting', () => {
    const queries: string[] = [];
    const sql = {
      exec(query: string) {
        queries.push(query);
        return { one: () => ({ rows: 0, bytes: 0, max_row_bytes: 0 }) };
      },
    } as unknown as SqlStorage;

    collectChatMemoryStats(sql);

    expect(queries).toHaveLength(4);
    for (const query of queries) {
      expect(query).toMatch(/COUNT\(\*\).*SUM\(length\(CAST\(/s);
      expect(query).toMatch(/MAX\(length\(CAST\(/s);
      expect(query).not.toMatch(/SELECT\s+(message|payload|body)\b/i);
      expect(query).not.toContain('r2_key');
      expect(query).not.toContain('hash');
    }
  });

  it('emits privacy-safe start/end pairs and leaves a start when work does not finish', () => {
    const events: Array<{ event: string; details: Record<string, unknown> }> =
      [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread-id',
      workspaceId: 'workspace-id',
      orgId: 'org-id',
      userId: 'user-id',
    };
    fake.lastChatMemoryStoreSnapshotAt = Date.now();
    fake.lastChatMemoryPhaseAt = new Map();
    fake.readChatMemoryStats = () => ({
      totalRows: 6,
      totalBytes: 42,
      maxRowBytes: 20,
      stores: {},
    });
    fake.recordChatThreadObservabilityEvent = (
      event: string,
      details: Record<string, unknown>,
    ) => events.push({ event, details });

    const completed = ChatThreadDO.prototype['startChatMemoryPhase'].call(
      fake,
      'pi_topup_read',
    );
    ChatThreadDO.prototype['endChatMemoryPhase'].call(fake, completed);
    ChatThreadDO.prototype['startChatMemoryPhase'].call(
      fake,
      'journal_recovery_load',
    ); // deliberately no end: this is the reset/OOM breadcrumb

    expect(
      events.map(({ details }) => [details.operation, details.status]),
    ).toEqual([
      ['pi_topup_read', 'start'],
      ['pi_topup_read', 'end'],
      ['journal_recovery_load', 'start'],
    ]);
    for (const { event, details } of events) {
      expect(event).toBe('chat_memory_phase');
      expect(Object.keys(details)).toEqual(
        expect.arrayContaining([
          'count',
          'operation',
          'sampleKey',
          'size',
          'status',
        ]),
      );
      expect(details).toMatchObject({
        count: 6,
        size: 42,
        sampleKey: 'thread-id',
      });
      const encoded = JSON.stringify(details).toLowerCase();
      for (const forbidden of [
        'content',
        'message',
        'r2',
        'storagekey',
        'hash',
        'toolargs',
        'tooloutput',
        'requestbody',
        'authorization',
      ]) {
        expect(encoded).not.toContain(forbidden);
      }
    }
  });

  it('rate-limits repetitive small-thread phases but never suppresses heavy phases', () => {
    const events: Array<Record<string, unknown>> = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread-id' };
    fake.lastChatMemoryStoreSnapshotAt = Date.now();
    fake.lastChatMemoryPhaseAt = new Map();
    fake.recordChatThreadObservabilityEvent = (
      _event: string,
      details: Record<string, unknown>,
    ) => events.push(details);
    const stats = { totalRows: 1, totalBytes: 42, maxRowBytes: 42, stores: {} };
    fake.readChatMemoryStats = () => stats;

    const first = ChatThreadDO.prototype['startChatMemoryPhase'].call(
      fake,
      'pi_read',
    );
    ChatThreadDO.prototype['endChatMemoryPhase'].call(fake, first);
    const suppressed = ChatThreadDO.prototype['startChatMemoryPhase'].call(
      fake,
      'pi_read',
    );
    ChatThreadDO.prototype['endChatMemoryPhase'].call(fake, suppressed);
    expect(events).toHaveLength(2);

    stats.totalBytes = 1024 * 1024;
    const heavy = ChatThreadDO.prototype['startChatMemoryPhase'].call(
      fake,
      'pi_read',
    );
    ChatThreadDO.prototype['endChatMemoryPhase'].call(fake, heavy);
    expect(events).toHaveLength(4);
  });
});

describe('ChatThreadDO memory telemetry integration', () => {
  it('does not export or retain a full-history reconnect-frame cache', async () => {
    expect(memoryTelemetry).not.toHaveProperty('ChatConnectFrameCache');
    const stub = await newChatThreadStub('thread-memory-no-frame-cache');
    await runInDurableObject(stub, async (instance: any) => {
      await instance.persistMessages([
        { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'kept' }] },
      ]);
      expect(instance).not.toHaveProperty('chatConnectFrameCache');
      expect(instance).not.toHaveProperty('cachedChatConnectFrame');
    });
  });

  it('leaves chat recovery retry configuration unchanged', async () => {
    const stub = await newChatThreadStub('thread-memory-retries-unchanged');
    await runInDurableObject(stub, async (instance: any) => {
      expect(instance.chatRecovery).toMatchObject({ maxAttempts: 3 });
      expect(instance.chatRecovery).not.toHaveProperty('maxOomRetries');
    });
  });

  it('reports measured:false for a store whose table does not exist', async () => {
    // The signal that keeps a mistargeted store from reporting a confident 0
    // forever. Previously indistinguishable from a genuinely empty store.
    const stub = await newChatThreadStub('thread-memory-unmeasurable');
    await runInDurableObject(stub, async (instance: any) => {
      const sql = instance.ctx.storage.sql;
      instance.ensurePiCoreTables();
      sql.exec('DROP TABLE IF EXISTS cf_ai_chat_agent_tool_runs');

      const stats = collectChatMemoryStats(sql);

      expect(stats.stores.toolRuns).toEqual({
        rows: 0,
        bytes: 0,
        maxRowBytes: 0,
        measured: false,
      });
      // An unmeasurable store must not be silently folded into the totals as 0.
      expect(stats.stores.pi.measured).toBe(true);
    });
  });
});
