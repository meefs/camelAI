/**
 * Worker Logs Durable Object
 *
 * In-memory ring buffer of recent logs per user script (and the platform
 * worker). Intentionally not persisted to SQLite: log tails are a live/debug
 * surface, and durable row storage was dominating Durable Object SQLite
 * rows-read cost under high log volume.
 *
 * Tradeoff: buffer contents are lost when the DO is evicted/hibernates with no
 * remaining state. Live WebSocket tails and warm getLogs/getStats still work.
 *
 * `EphemeralWorkerLogsDO` is kept as a thin alias so any older bindings that
 * still point at that class name keep working.
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
  private logs: LogEntry[] = [];
  private nextId = 1;
  private lastLogAt: number | null = null;
  private writeWindowStartedAt = 0;
  private writesInWindow = 0;
  private hasWrittenSamplingWarningInWindow = false;

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

    // Replay recent logs on connect (only what is still warm in memory).
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
          insertedLogs.push(this.insertLog(createLogSamplingWarning(now)));
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

  /**
   * Get recent logs for the script.
   */
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

  /**
   * Get log statistics for the script.
   */
  async getStats(): Promise<{ logCount: number; lastLogAt: number | null }> {
    return {
      logCount: this.logs.length,
      lastLogAt: this.lastLogAt,
    };
  }

  /**
   * Clear all logs for the script.
   */
  async clearLogs(): Promise<void> {
    this.logs = [];
    this.nextId = 1;
    this.lastLogAt = null;
  }

  /**
   * Drop oldest entries once the in-memory ring buffer is full.
   */
  private pruneOldLogs(): void {
    const overflow = this.logs.length - MAX_LOGS;
    if (overflow <= 0) return;
    this.logs.splice(0, overflow);
  }
}

/**
 * Compatibility alias for older bindings / migrations that still reference the
 * ephemeral class name. Behavior matches {@link WorkerLogsDO}.
 */
export class EphemeralWorkerLogsDO extends WorkerLogsDO {}
