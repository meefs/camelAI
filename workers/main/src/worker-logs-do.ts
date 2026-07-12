/**
 * Worker Logs Durable Objects
 *
 * `WorkerLogsDO` stores logs per user script using SQLite so logs survive normal
 * Durable Object eviction/restart behavior.
 *
 * `EphemeralWorkerLogsDO` is kept temporarily for rollout compatibility with any
 * older bindings that still point at the ephemeral class introduced during the
 * previous deployment.
 */

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types.js';

export interface LogEvent {
  timestamp: number;
  level: string;
  message: string | null;
  exception: string | null;
  scriptVersion: string | null;
}

export interface LogEntry {
  id: number;
  timestamp: number;
  level: string;
  message: string | null;
  exception: string | null;
  scriptVersion: string | null;
}

type LogRow = {
  id: number;
  timestamp: number;
  level: string;
  message: string | null;
  exception: string | null;
  script_version: string | null;
  [key: string]: SqlStorageValue;
};

type StatsRow = {
  count: number;
  last_log: number | null;
  [key: string]: SqlStorageValue;
};

export interface GetLogsOptions {
  limit?: number;
  since?: number;
}

const MAX_LOGS = 10000;
const REPLAY_LIMIT = 100;
const LOG_WRITE_WINDOW_MS = 5_000;
const MAX_LOG_WRITES_PER_WINDOW = 200;
const LOG_SAMPLING_WARNING_LEVEL = 'warn';

function createLogSamplingWarning(now: number): LogEvent {
  return {
    timestamp: now,
    level: LOG_SAMPLING_WARNING_LEVEL,
    message: `Log sampling active: dropping worker logs because write rate exceeded ${MAX_LOG_WRITES_PER_WINDOW} entries per ${LOG_WRITE_WINDOW_MS / 1000}s window.`,
    exception: null,
    scriptVersion: null,
  };
}

export class WorkerLogsDO extends DurableObject<Env> {
  private sql: SqlStorage;
  private writeWindowStartedAt = 0;
  private writesInWindow = 0;
  private hasWrittenSamplingWarningInWindow = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.migrate();
  }

  /**
   * Handle WebSocket upgrades for real-time log streaming.
   */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    // Replay recent logs on connect.
    const recent = await this.getLogs({ limit: REPLAY_LIMIT });
    server.send(JSON.stringify({ type: 'replay', logs: recent.reverse() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle WebSocket close (hibernation API).
   */
  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Connection closed, nothing to clean up (hibernation handles it).
  }

  /**
   * Handle WebSocket error (hibernation API).
   */
  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('[WorkerLogsDO] WebSocket error:', error);
  }

  private migrate(): void {
    const version = this.ctx.storage.kv.get<number>('schemaVersion') ?? 0;

    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS logs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          level TEXT NOT NULL,
          message TEXT,
          exception TEXT,
          script_version TEXT
        )
      `);
      this.sql.exec('CREATE INDEX IF NOT EXISTS idx_logs_timestamp ON logs(timestamp)');
      this.ctx.storage.kv.put('schemaVersion', 1);
    }
  }

  /**
   * Ingest logs from the tail worker. Called via RPC.
   */
  async ingestLogs(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return;

    const now = Date.now();
    const insertedLogs: LogEntry[] = [];

    this.rotateWriteWindow(now);

    for (const event of events) {
      if (!this.canWriteEventInWindow()) {
        if (!this.hasWrittenSamplingWarningInWindow && this.tryConsumeWriteSlot()) {
          const warning = createLogSamplingWarning(now);
          insertedLogs.push(this.insertLogRow(warning));
          this.hasWrittenSamplingWarningInWindow = true;
        }
        continue;
      }

      this.tryConsumeWriteSlot();

      insertedLogs.push(this.insertLogRow({
        timestamp: event.timestamp ?? now,
        level: event.level ?? 'log',
        message: event.message ?? null,
        exception: event.exception ?? null,
        scriptVersion: event.scriptVersion ?? null,
      }));
    }

    if (insertedLogs.length === 0) return;

    this.pruneOldLogs();

    // Broadcast to connected WebSocket clients.
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      const payload = JSON.stringify({ type: 'logs', logs: insertedLogs });
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          // Client disconnected, ignore.
        }
      }
    }
  }

  private rotateWriteWindow(now: number): void {
    if (this.writeWindowStartedAt === 0 || now - this.writeWindowStartedAt >= LOG_WRITE_WINDOW_MS) {
      this.writeWindowStartedAt = now;
      this.writesInWindow = 0;
      this.hasWrittenSamplingWarningInWindow = false;
    }
  }

  private canWriteEventInWindow(): boolean {
    const reservedSlots = this.hasWrittenSamplingWarningInWindow ? 0 : 1;
    return this.writesInWindow < MAX_LOG_WRITES_PER_WINDOW - reservedSlots;
  }

  private tryConsumeWriteSlot(): boolean {
    if (this.writesInWindow >= MAX_LOG_WRITES_PER_WINDOW) return false;
    this.writesInWindow += 1;
    return true;
  }

  private insertLogRow(event: LogEvent): LogEntry {
    this.sql.exec(
      `INSERT INTO logs (timestamp, level, message, exception, script_version)
       VALUES (?, ?, ?, ?, ?)`,
      event.timestamp,
      event.level,
      event.message,
      event.exception,
      event.scriptVersion
    );

    const lastId = this.sql.exec<{ id: number; [key: string]: SqlStorageValue }>(
      'SELECT last_insert_rowid() as id'
    ).toArray()[0]?.id ?? 0;

    return {
      id: lastId,
      timestamp: event.timestamp,
      level: event.level,
      message: event.message,
      exception: event.exception,
      scriptVersion: event.scriptVersion,
    };
  }

  /**
   * Get recent logs for the script.
   */
  async getLogs(opts: GetLogsOptions = {}): Promise<LogEntry[]> {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const since = opts.since ?? 0;

    const rows = this.sql.exec<LogRow>(
      `SELECT id, timestamp, level, message, exception, script_version
       FROM logs
       WHERE timestamp > ?
       ORDER BY timestamp DESC
       LIMIT ?`,
      since,
      limit
    ).toArray();

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      message: row.message,
      exception: row.exception,
      scriptVersion: row.script_version,
    }));
  }

  /**
   * Get log statistics for the script.
   */
  async getStats(): Promise<{ logCount: number; lastLogAt: number | null }> {
    const row = this.sql.exec<StatsRow>(
      'SELECT COUNT(*) as count, MAX(timestamp) as last_log FROM logs'
    ).toArray()[0];

    return {
      logCount: row?.count ?? 0,
      lastLogAt: row?.last_log ?? null,
    };
  }

  /**
   * Clear all logs for the script.
   */
  async clearLogs(): Promise<void> {
    this.sql.exec('DELETE FROM logs');
  }

  /**
   * Prune old logs to keep storage bounded (circular buffer).
   */
  private pruneOldLogs(): void {
    const count = this.sql.exec<{ c: number; [key: string]: SqlStorageValue }>(
      'SELECT COUNT(*) as c FROM logs'
    ).toArray()[0]?.c ?? 0;

    if (count <= MAX_LOGS) return;

    this.sql.exec(
      `DELETE FROM logs WHERE id IN (
        SELECT id FROM logs ORDER BY timestamp ASC LIMIT ?
      )`,
      count - MAX_LOGS
    );
  }
}

export class EphemeralWorkerLogsDO extends DurableObject<Env> {
  private logs: LogEntry[] = [];
  private nextId = 1;
  private lastLogAt: number | null = null;
  private writeWindowStartedAt = 0;
  private writesInWindow = 0;
  private hasWrittenSamplingWarningInWindow = false;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const recent = await this.getLogs({ limit: REPLAY_LIMIT });
    server.send(JSON.stringify({ type: 'replay', logs: recent.reverse() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    // Connection closed, nothing to clean up (hibernation handles it).
  }

  webSocketError(_ws: WebSocket, error: unknown): void {
    console.error('[EphemeralWorkerLogsDO] WebSocket error:', error);
  }

  async ingestLogs(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return;

    const now = Date.now();
    const insertedLogs: LogEntry[] = [];

    this.rotateWriteWindow(now);

    for (const event of events) {
      if (!this.canWriteEventInWindow()) {
        if (!this.hasWrittenSamplingWarningInWindow && this.tryConsumeWriteSlot()) {
          insertedLogs.push(this.insertLog({
            timestamp: now,
            level: LOG_SAMPLING_WARNING_LEVEL,
            message: createLogSamplingWarning(now).message,
            exception: null,
            scriptVersion: null,
          }));
          this.hasWrittenSamplingWarningInWindow = true;
        }
        continue;
      }

      this.tryConsumeWriteSlot();

      insertedLogs.push(this.insertLog({
        timestamp: event.timestamp ?? now,
        level: event.level ?? 'log',
        message: event.message ?? null,
        exception: event.exception ?? null,
        scriptVersion: event.scriptVersion ?? null,
      }));
    }

    if (insertedLogs.length === 0) return;

    this.logs.sort((left, right) => {
      if (left.timestamp !== right.timestamp) {
        return left.timestamp - right.timestamp;
      }
      return left.id - right.id;
    });
    this.pruneOldLogs();

    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      const payload = JSON.stringify({ type: 'logs', logs: insertedLogs });
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          // Client disconnected, ignore.
        }
      }
    }
  }

  private rotateWriteWindow(now: number): void {
    if (this.writeWindowStartedAt === 0 || now - this.writeWindowStartedAt >= LOG_WRITE_WINDOW_MS) {
      this.writeWindowStartedAt = now;
      this.writesInWindow = 0;
      this.hasWrittenSamplingWarningInWindow = false;
    }
  }

  private canWriteEventInWindow(): boolean {
    const reservedSlots = this.hasWrittenSamplingWarningInWindow ? 0 : 1;
    return this.writesInWindow < MAX_LOG_WRITES_PER_WINDOW - reservedSlots;
  }

  private tryConsumeWriteSlot(): boolean {
    if (this.writesInWindow >= MAX_LOG_WRITES_PER_WINDOW) return false;
    this.writesInWindow += 1;
    return true;
  }

  private insertLog(event: LogEvent): LogEntry {
    const entry: LogEntry = {
      id: this.nextId++,
      timestamp: event.timestamp,
      level: event.level,
      message: event.message,
      exception: event.exception,
      scriptVersion: event.scriptVersion,
    };

    this.logs.push(entry);
    this.lastLogAt = this.lastLogAt === null ? entry.timestamp : Math.max(this.lastLogAt, entry.timestamp);
    return entry;
  }

  async getLogs(opts: GetLogsOptions = {}): Promise<LogEntry[]> {
    const limit = Math.min(opts.limit ?? 100, 1000);
    const since = opts.since ?? 0;
    const recent: LogEntry[] = [];

    for (let index = this.logs.length - 1; index >= 0; index -= 1) {
      const entry = this.logs[index];
      if (entry.timestamp <= since) continue;
      recent.push(entry);
      if (recent.length >= limit) break;
    }

    return recent;
  }

  async getStats(): Promise<{ logCount: number; lastLogAt: number | null }> {
    return {
      logCount: this.logs.length,
      lastLogAt: this.lastLogAt,
    };
  }

  async clearLogs(): Promise<void> {
    this.logs = [];
    this.nextId = 1;
    this.lastLogAt = null;
  }

  private pruneOldLogs(): void {
    const overflow = this.logs.length - MAX_LOGS;
    if (overflow <= 0) return;
    this.logs.splice(0, overflow);
  }
}
