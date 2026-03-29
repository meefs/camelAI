/**
 * Worker Logs Durable Object
 *
 * Stores logs per user script in memory only.
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

export interface GetLogsOptions {
  limit?: number;
  since?: number;
}

const MAX_LOGS = 10000;
const REPLAY_LIMIT = 100;

export class EphemeralWorkerLogsDO extends DurableObject<Env> {
  private logs: LogEntry[] = [];
  private nextId = 1;
  private lastLogAt: number | null = null;

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
  webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    // Connection closed, nothing to clean up (hibernation handles it).
  }

  /**
   * Handle WebSocket error (hibernation API).
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    console.error('[EphemeralWorkerLogsDO] WebSocket error:', error);
  }

  /**
   * Ingest logs from the tail worker. Called via RPC.
   */
  async ingestLogs(events: LogEvent[]): Promise<void> {
    if (events.length === 0) return;

    const now = Date.now();
    const insertedLogs: LogEntry[] = [];

    for (const event of events) {
      const entry: LogEntry = {
        id: this.nextId++,
        timestamp: event.timestamp ?? now,
        level: event.level ?? 'log',
        message: event.message ?? null,
        exception: event.exception ?? null,
        scriptVersion: event.scriptVersion ?? null,
      };

      this.logs.push(entry);
      this.lastLogAt = this.lastLogAt === null ? entry.timestamp : Math.max(this.lastLogAt, entry.timestamp);
      insertedLogs.push(entry);
    }

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
   * Prune old logs to keep storage bounded (circular buffer).
   */
  private pruneOldLogs(): void {
    const overflow = this.logs.length - MAX_LOGS;
    if (overflow <= 0) return;
    this.logs.splice(0, overflow);
  }
}
