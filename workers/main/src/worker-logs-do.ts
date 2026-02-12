/**
 * Worker Logs Durable Object
 *
 * Stores logs per user script using SQLite.
 * Supports WebSocket connections for real-time log streaming.
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

export class WorkerLogsDO extends DurableObject<Env> {
  private sql: SqlStorage;

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

    // Replay recent logs on connect
    const recent = await this.getLogs({ limit: REPLAY_LIMIT });
    server.send(JSON.stringify({ type: 'replay', logs: recent.reverse() }));

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Handle WebSocket close (hibernation API).
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // Connection closed, nothing to clean up (hibernation handles it)
  }

  /**
   * Handle WebSocket error (hibernation API).
   */
  webSocketError(ws: WebSocket, error: unknown): void {
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

    for (const event of events) {
      this.sql.exec(
        `INSERT INTO logs (timestamp, level, message, exception, script_version)
         VALUES (?, ?, ?, ?, ?)`,
        event.timestamp ?? now,
        event.level ?? 'log',
        event.message ?? null,
        event.exception ?? null,
        event.scriptVersion ?? null
      );

      // Get the inserted row ID for the LogEntry
      const lastId = this.sql.exec<{ id: number; [key: string]: SqlStorageValue }>(
        'SELECT last_insert_rowid() as id'
      ).toArray()[0]?.id ?? 0;

      insertedLogs.push({
        id: lastId,
        timestamp: event.timestamp ?? now,
        level: event.level ?? 'log',
        message: event.message ?? null,
        exception: event.exception ?? null,
        scriptVersion: event.scriptVersion ?? null,
      });
    }

    this.pruneOldLogs();

    // Broadcast to connected WebSocket clients
    const sockets = this.ctx.getWebSockets();
    if (sockets.length > 0) {
      const payload = JSON.stringify({ type: 'logs', logs: insertedLogs });
      for (const ws of sockets) {
        try {
          ws.send(payload);
        } catch {
          // Client disconnected, ignore
        }
      }
    }
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

    return rows.map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      level: row.level,
      message: row.message,
      exception: row.exception,
      scriptVersion: row.script_version,
    }));
  }

  /**
   * Get log statistics for the script (derived from SQL).
   */
  async getStats(): Promise<{ logCount: number; lastLogAt: number | null }> {
    const row = this.sql.exec<StatsRow>(
      `SELECT COUNT(*) as count, MAX(timestamp) as last_log FROM logs`
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
