import { DurableObject } from 'cloudflare:workers';
import type { WorkspaceContainer } from './workspace-container';
import type { OrgDO } from './auth';

// Preview state for a thread
export interface PreviewState {
  workers: string[]; // Worker script names to preview
  isPublic?: boolean;
}

// Connection setup prompt request
export interface ConnectionSetupRequest {
  requestId: string;
  integrationType: string; // Required: the integration type to set up
  suggestedName?: string; // Optional: suggested name for the connection
  message?: string; // Optional: message to show user
  createdAt: number;
}

// Connection setup response from user
export interface ConnectionSetupResponse {
  requestId: string;
  cancelled: boolean;
  integration?: {
    type: string;
    name: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  };
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

// Forward declaration for MCP DO RPC methods - used for callback from ChatThreadDO
interface ChiridionMcpRpc {
  receiveConnectionSetupResponse(response: ConnectionSetupResponse): void;
}

export interface ChatEnv {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  SANDBOX: DurableObjectNamespace<WorkspaceContainer>;
  ORG: DurableObjectNamespace<OrgDO>;
  MCP_OBJECT: DurableObjectNamespace;
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
// Pending connection setup with MCP callback info
interface PendingConnectionSetupInfo {
  mcpDoId: string;
  createdAt: number;
}

export class ChatThreadDO extends DurableObject<ChatEnv> {
  private previewWorkers: string[] = [];
  private previewVersion: number = 0;
  private previewIsPublic: boolean = false;
  // Pending connection setup requests (requestId -> MCP DO callback info)
  // This is also persisted to storage to survive hibernation
  private pendingConnectionSetups: Map<string, PendingConnectionSetupInfo> = new Map();

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
      const stored = ctx.storage.kv.get<string[]>('previewWorkers');
      if (stored) {
        this.previewWorkers = stored;
      }
      const version = ctx.storage.kv.get<number>('previewVersion');
      if (typeof version === 'number') {
        this.previewVersion = version;
      }
      const storedIsPublic = ctx.storage.kv.get<boolean>('previewIsPublic');
      if (typeof storedIsPublic === 'boolean') {
        this.previewIsPublic = storedIsPublic;
      } else if (this.previewWorkers[0]) {
        try {
          const stored = await this.env.API_TOKENS.get(`script_org:${this.previewWorkers[0]}`);
          if (stored) {
            const parsed = JSON.parse(stored) as { is_public?: boolean };
            if (typeof parsed.is_public === 'boolean') {
              this.previewIsPublic = parsed.is_public;
              ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
            }
          }
        } catch (err) {
          console.error('[ChatThreadDO] Failed to backfill preview visibility', err);
        }
      }

      // Restore pending connection setups from storage (sync KV)
      const pendingEntries = ctx.storage.kv.list({ prefix: 'pending_connection:' });
      for (const [key, value] of pendingEntries) {
        const info = value as PendingConnectionSetupInfo;
        const requestId = key.replace('pending_connection:', '');
        // Only restore if not expired (30 minutes)
        if (Date.now() - info.createdAt < 30 * 60 * 1000) {
          this.pendingConnectionSetups.set(requestId, info);
        } else {
          // Clean up expired entries
          ctx.storage.kv.delete(key);
        }
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
        isPublic: this.previewIsPublic,
      }));

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP API for setting preview state
    if (url.pathname === '/preview' && request.method === 'POST') {
      const body = await request.json() as { workers?: string[]; isPublic?: boolean };
      if (body.workers) {
        await this.setPreviewWorkers(body.workers, body.isPublic);
      }
      return new Response(JSON.stringify({
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (url.pathname === '/preview' && request.method === 'GET') {
      return new Response(JSON.stringify({
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
      }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // HTTP API for connection setup prompts (called by MCP server)
    if (url.pathname === '/connection-setup/prompt' && request.method === 'POST') {
      const body = await request.json() as ConnectionSetupRequest & { mcpDoId?: string };
      const requestId = body.requestId || crypto.randomUUID();
      const mcpDoId = body.mcpDoId;

      if (!mcpDoId) {
        return new Response(JSON.stringify({ error: 'Missing MCP DO ID for callback' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (!body.integrationType) {
        return new Response(JSON.stringify({ error: 'Missing integrationType - connection type must be specified' }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Store pending request with MCP callback info (both in-memory and durable storage)
      const pendingInfo: PendingConnectionSetupInfo = {
        mcpDoId,
        createdAt: Date.now(),
      };
      this.pendingConnectionSetups.set(requestId, pendingInfo);
      this.ctx.storage.kv.put(`pending_connection:${requestId}`, pendingInfo);

      // Broadcast prompt to all connected clients
      this.broadcast({
        type: 'connection_setup_prompt',
        requestId,
        integrationType: body.integrationType,
        suggestedName: body.suggestedName,
        message: body.message,
      });

      return new Response(JSON.stringify({ requestId }), {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response('Not found', { status: 404 });
  }

  // Handle WebSocket messages (for connection setup responses)
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    try {
      const data = JSON.parse(message) as { type: string; [key: string]: unknown };

      if (data.type === 'connection_setup_response') {
        const response = data as unknown as ConnectionSetupResponse;
        const pendingInfo = this.pendingConnectionSetups.get(response.requestId);

        if (response.requestId && pendingInfo) {
          // Clean up pending request (both in-memory and durable storage)
          this.pendingConnectionSetups.delete(response.requestId);
          this.ctx.storage.kv.delete(`pending_connection:${response.requestId}`);

          // Call back to MCP DO via RPC
          try {
            const mcpDoId = this.env.MCP_OBJECT.idFromString(pendingInfo.mcpDoId);
            const mcpStub = this.env.MCP_OBJECT.get(mcpDoId) as unknown as ChiridionMcpRpc;
            await mcpStub.receiveConnectionSetupResponse(response);
          } catch (err) {
            console.error('[ChatThreadDO] Failed to call MCP DO callback:', err);
          }
        }
      }
    } catch {
      // Ignore invalid JSON
    }
  }

  // Get preview workers
  getPreviewWorkers(): string[] {
    return this.previewWorkers;
  }

  // Set preview workers and broadcast to all connected clients
  async setPreviewWorkers(workers: string[], isPublic?: boolean): Promise<void> {
    this.previewWorkers = workers;
    if (workers.length === 0) {
      this.previewIsPublic = false;
    } else if (typeof isPublic === 'boolean') {
      this.previewIsPublic = isPublic;
    }
    this.previewVersion++;
    this.ctx.storage.kv.put('previewWorkers', workers);
    this.ctx.storage.kv.put('previewVersion', this.previewVersion);
    this.ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
    this.broadcast({
      type: 'preview_state',
      workers: this.previewWorkers,
      version: this.previewVersion,
      isPublic: this.previewIsPublic,
    });
  }

  // Update preview visibility without bumping version (avoid iframe reloads)
  async setPreviewVisibility(isPublic: boolean): Promise<void> {
    this.previewIsPublic = isPublic;
    this.ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
    this.broadcast({
      type: 'preview_state',
      workers: this.previewWorkers,
      version: this.previewVersion,
      isPublic: this.previewIsPublic,
    });
  }

  // Add a worker to preview list
  async addPreviewWorker(worker: string): Promise<void> {
    if (!this.previewWorkers.includes(worker)) {
      this.previewWorkers.push(worker);
      this.ctx.storage.kv.put('previewWorkers', this.previewWorkers);
      this.broadcast({
        type: 'preview_state',
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
      });
    }
  }

  // Remove a worker from preview list
  async removePreviewWorker(worker: string): Promise<void> {
    const index = this.previewWorkers.indexOf(worker);
    if (index !== -1) {
      this.previewWorkers.splice(index, 1);
      if (this.previewWorkers.length === 0) {
        this.previewIsPublic = false;
        this.ctx.storage.kv.put('previewIsPublic', this.previewIsPublic);
      }
      this.ctx.storage.kv.put('previewWorkers', this.previewWorkers);
      this.broadcast({
        type: 'preview_state',
        workers: this.previewWorkers,
        isPublic: this.previewIsPublic,
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
