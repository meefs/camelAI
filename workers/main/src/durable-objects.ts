import { DurableObject } from 'cloudflare:workers';
import type { WorkspaceContainer } from './workspace-container';
import type { OrgDO } from './auth';
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
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  SANDBOX: DurableObjectNamespace<WorkspaceContainer>;
  ORG: DurableObjectNamespace<OrgDO>;
  DO_RPC: Service<DoRpcService>;
  API_TOKENS: KVNamespace;
  R2_BUCKET: R2Bucket;
  AI: Ai;
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

/**
 * ChatThreadDO - One per thread, holds out-of-band state like preview workers.
 * Accepts WebSocket connections for live updates.
 */
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private previewWorkers: string[] = [];
  private previewVersion: number = 0;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);

    // Set up auto-response for ping messages - responds without waking the DO
    ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: 'ping' }),
        JSON.stringify({ type: 'pong' })
      )
    );

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

  // Set thread title and broadcast to connected clients
  async setTitle(title: string): Promise<void> {
    this.broadcast({ type: 'title_updated', title });
  }

  // Broadcast message to all connected WebSocket clients
  // Uses ctx.getWebSockets() to get hibernated connections (in-memory Set won't survive hibernation)
  private broadcast(message: object): void {
    const json = JSON.stringify(message);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(json);
      } catch {
        // WebSocket is already closed, ignore
      }
    }
  }
}
