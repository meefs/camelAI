import { DurableObject } from 'cloudflare:workers';
import type { OrgContainer } from './org-container';
import type { OrgDO, SessionDO } from './auth';
import type { DoRpcService } from './rpc-service';

// Preview state for a thread
export interface PreviewState {
  workers: string[]; // Worker script names to preview
}

export interface Thread {
  id: string;
  title: string;
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface Message {
  id: string;
  thread_id: string;
  role: 'user' | 'assistant';
  content: string;
  created_at: number;
}

export interface ChatEnv {
  CHAT_INDEX: DurableObjectNamespace<ChatIndexDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  SANDBOX: DurableObjectNamespace<OrgContainer>;
  ORG: DurableObjectNamespace<OrgDO>;
  SESSION: DurableObjectNamespace<SessionDO>;
  DO_RPC: Service<DoRpcService>;
  API_TOKENS: KVNamespace;
  R2_BUCKET: R2Bucket;
  ANTHROPIC_API_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  EMAIL_TO_USER: KVNamespace;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_MOUNT_DIR?: string;
  R2_MOUNT_READONLY?: string;
  R2_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  PLATFORM_SCRIPT_TOKENS?: KVNamespace;
  DEBUG_CLAUDE_AGENT_SDK?: string;
}

// One DO per org - stores thread list only
export class ChatIndexDO extends DurableObject<ChatEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate() {
    // Create schema version table first (if not exists)
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS _schema_version (
        version INTEGER PRIMARY KEY
      )
    `);
    const rows = this.sql.exec<{ version: number }>('SELECT version FROM _schema_version LIMIT 1').toArray();
    const version = rows[0]?.version ?? 0;

    if (version < 1) {
      // V1: Fresh start - drop old tables and create new schema
      this.sql.exec('DROP TABLE IF EXISTS projects');
      this.sql.exec('DROP TABLE IF EXISTS threads');
      this.sql.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE threads (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          project_id TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec('CREATE INDEX projects_created_by ON projects(created_by)');
      this.sql.exec('INSERT INTO _schema_version (version) VALUES (1)');
    }

    if (version < 2) {
      // V2: Add created_by column to threads
      this.sql.exec('ALTER TABLE threads ADD COLUMN created_by TEXT NOT NULL DEFAULT "system"');
      this.sql.exec('CREATE INDEX threads_created_by ON threads(created_by)');
      this.sql.exec('UPDATE _schema_version SET version = 2');
    }

    if (version < 3) {
      // V3: Remove projects - drop project_id from threads and drop projects table
      // SQLite doesn't support DROP COLUMN easily, so we recreate the table
      this.sql.exec(`
        CREATE TABLE threads_new (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          created_by TEXT NOT NULL DEFAULT "system",
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        INSERT INTO threads_new (id, title, created_by, created_at, updated_at)
        SELECT id, title, created_by, created_at, updated_at FROM threads
      `);
      this.sql.exec('DROP TABLE threads');
      this.sql.exec('ALTER TABLE threads_new RENAME TO threads');
      this.sql.exec('CREATE INDEX threads_created_by ON threads(created_by)');
      this.sql.exec('DROP TABLE IF EXISTS projects');
      this.sql.exec('DROP INDEX IF EXISTS projects_created_by');
      this.sql.exec('UPDATE _schema_version SET version = 3');
    }
  }

  getThreads(): Thread[] {
    return this.sql.exec('SELECT * FROM threads ORDER BY updated_at DESC').toArray() as unknown as Thread[];
  }

  getThreadsPaginated(offset = 0, limit = 50): { items: Thread[]; total: number; offset: number; limit: number } {
    const resolvedOffset = Math.max(0, Math.floor(offset));
    const resolvedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const items = this.sql
      .exec(
        'SELECT * FROM threads ORDER BY updated_at DESC LIMIT ? OFFSET ?',
        resolvedLimit,
        resolvedOffset
      )
      .toArray() as unknown as Thread[];
    const totalRows = this.sql.exec('SELECT COUNT(*) as count FROM threads').toArray() as Array<{ count: number }>;
    const total = Number(totalRows[0]?.count ?? 0);

    return {
      items,
      total,
      offset: resolvedOffset,
      limit: resolvedLimit,
    };
  }

  /**
   * Create a thread. If sessionId is provided, use it as the thread ID (Claude session_id).
   * If the thread already exists, return the existing thread.
   */
  createThread(title: string | undefined, createdBy?: string, sessionId?: string): Thread {
    // If sessionId provided, check if thread already exists
    const id = sessionId?.trim() || crypto.randomUUID();
    const existing = this.getThread(id);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const t = title || 'New Chat';
    const creator = createdBy?.trim() || 'system';
    this.sql.exec(
      'INSERT INTO threads (id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      t,
      creator,
      now,
      now
    );
    return {
      id,
      title: t,
      created_by: creator,
      created_at: now,
      updated_at: now,
    };
  }

  getThread(id: string): Thread | null {
    const rows = this.sql.exec('SELECT * FROM threads WHERE id = ?', id).toArray() as unknown as Thread[];
    return rows[0] || null;
  }

  updateThread(id: string, title: string): Thread | null {
    const now = Date.now();
    this.sql.exec('UPDATE threads SET title = ?, updated_at = ? WHERE id = ?', title, now, id);
    return this.getThread(id);
  }

  deleteThread(id: string): boolean {
    this.sql.exec('DELETE FROM threads WHERE id = ?', id);
    return true;
  }

  touchThread(id: string): void {
    const now = Date.now();
    this.sql.exec('UPDATE threads SET updated_at = ? WHERE id = ?', now, id);
  }
}

/**
 * ChatThreadDO - One per thread, holds out-of-band state like preview workers.
 * Accepts WebSocket connections for live updates.
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private connections: Set<WebSocket> = new Set();
  private previewWorkers: string[] = [];
  private previewVersion: number = 0;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);

    // Restore state from storage
    ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<string[]>('previewWorkers');
      if (stored) {
        this.previewWorkers = stored;
      }
      const version = await ctx.storage.get<number>('previewVersion');
      if (version) {
        this.previewVersion = version;
      }
    });
  }

  // Handle WebSocket upgrade
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);
      this.connections.add(server);

      // Send current state immediately
      server.send(JSON.stringify({
        type: 'preview_state',
        workers: this.previewWorkers,
        version: this.previewVersion,
      }));

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP API for setting preview state
    if (url.pathname === '/preview' && request.method === 'POST') {
      const body = await request.json() as { workers?: string[] };
      if (body.workers) {
        await this.setPreviewWorkers(body.workers);
      }
      return new Response(JSON.stringify({ workers: this.previewWorkers }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/preview' && request.method === 'GET') {
      return new Response(JSON.stringify({ workers: this.previewWorkers }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Set preview workers and broadcast to all connected clients
  async setPreviewWorkers(workers: string[]): Promise<void> {
    this.previewWorkers = workers;
    this.previewVersion++;
    await this.ctx.storage.put('previewWorkers', workers);
    await this.ctx.storage.put('previewVersion', this.previewVersion);
    this.broadcast({
      type: 'preview_state',
      workers: this.previewWorkers,
      version: this.previewVersion,
    });
  }

  // Add a worker to preview list
  async addPreviewWorker(worker: string): Promise<void> {
    if (!this.previewWorkers.includes(worker)) {
      this.previewWorkers.push(worker);
      await this.ctx.storage.put('previewWorkers', this.previewWorkers);
      this.broadcast({
        type: 'preview_state',
        workers: this.previewWorkers,
      });
    }
  }

  // Remove a worker from preview list
  async removePreviewWorker(worker: string): Promise<void> {
    const index = this.previewWorkers.indexOf(worker);
    if (index !== -1) {
      this.previewWorkers.splice(index, 1);
      await this.ctx.storage.put('previewWorkers', this.previewWorkers);
      this.broadcast({
        type: 'preview_state',
        workers: this.previewWorkers,
      });
    }
  }

  // Broadcast message to all connected WebSocket clients
  private broadcast(message: object): void {
    const json = JSON.stringify(message);
    for (const ws of this.connections) {
      try {
        ws.send(json);
      } catch {
        this.connections.delete(ws);
      }
    }
  }

  // Handle WebSocket close
  webSocketClose(ws: WebSocket): void {
    this.connections.delete(ws);
  }

  // Handle WebSocket error
  webSocketError(ws: WebSocket): void {
    this.connections.delete(ws);
  }
}
