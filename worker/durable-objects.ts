import { DurableObject } from 'cloudflare:workers';
import { getSandbox, parseSSEStream, type Sandbox, type ExecEvent } from '@cloudflare/sandbox';

export interface Thread {
  id: string;
  title: string;
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
  CHAT_INDEX: DurableObjectNamespace<ChatIndexDO>;
  SANDBOX: DurableObjectNamespace<Sandbox>;
  ANTHROPIC_API_KEY: string;
}

// One DO per org - stores thread list only
export class ChatIndexDO extends DurableObject<ChatEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  getThreads(): Thread[] {
    return this.sql.exec('SELECT * FROM threads ORDER BY updated_at DESC').toArray() as unknown as Thread[];
  }

  createThread(title?: string): Thread {
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = title || 'New Chat';
    this.sql.exec('INSERT INTO threads (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)', id, t, now, now);
    return { id, title: t, created_at: now, updated_at: now };
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

// One DO per thread - handles WebSocket + messages
export class ChatThreadDO extends DurableObject<ChatEnv> {
  private sql: SqlStorage;
  private sessionId: string;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    // Load or create session ID for this thread
    const rows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'session_id').toArray();
    if (rows.length > 0) {
      this.sessionId = (rows[0] as { value: string }).value;
    } else {
      this.sessionId = crypto.randomUUID();
      this.sql.exec('INSERT INTO metadata (key, value) VALUES (?, ?)', 'session_id', this.sessionId);
    }
  }

  // WebSocket handling
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/websocket') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);

      // Send existing messages on connect
      const messages = this.getMessages();
      server.send(JSON.stringify({ type: 'history', messages }));

      // Start warming up the sandbox in the background (don't await)
      this.warmSandbox();

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // Warm up the sandbox container so it's ready for commands
  private async warmSandbox() {
    try {
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
      // Execute a simple command to boot the container
      await sandbox.exec('true');
    } catch (e) {
      console.error('Failed to warm sandbox:', e);
    }
  }

  // Called when WebSocket message received
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message as string);

      if (data.type === 'message') {
        // Save user message
        const userMsg = this.addMessage('user', data.content);
        this.broadcast({ type: 'message', message: userMsg });

        // Get sandbox for this thread
        const sandboxId = this.ctx.id.toString().slice(0, 63);
        const sandbox = getSandbox(this.env.SANDBOX, sandboxId);

        // Stream Claude SDK driver output using execStream
        console.log('[DO] API key present:', !!this.env.ANTHROPIC_API_KEY, 'length:', this.env.ANTHROPIC_API_KEY?.length);
        const stream = await sandbox.execStream('node /app/driver.mjs', {
          env: {
            ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
            CLAUDE_PROMPT: data.content,
            SESSION_ID: this.sessionId
          }
        });

        let finalContent = '';
        let outputBuffer = '';

        // Process streaming events
        for await (const execEvent of parseSSEStream<ExecEvent>(stream)) {
          console.log('[DO] execEvent:', execEvent.type, execEvent.data?.substring(0, 100));
          if (execEvent.type === 'stdout' && execEvent.data) {
            outputBuffer += execEvent.data;
            // Process complete NDJSON lines
            const lines = outputBuffer.split('\n');
            outputBuffer = lines.pop() || '';

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const event = JSON.parse(line);
                console.log('[DO] SDK event:', event.type);
                // Forward event to client for rendering
                this.broadcast({ type: 'sdk_event', event });

                // Track final content for saving
                if (event.type === 'assistant' && event.message?.content) {
                  const textBlock = event.message.content.find((b: { type: string }) => b.type === 'text');
                  if (textBlock?.text) {
                    finalContent = textBlock.text;
                  }
                } else if (event.type === 'result') {
                  finalContent = event.result || finalContent;
                }
              } catch {
                // Skip malformed lines
              }
            }
          } else if (execEvent.type === 'stderr' && execEvent.data) {
            console.log('Driver stderr:', execEvent.data);
          } else if (execEvent.type === 'complete') {
            // Process any remaining buffer
            if (outputBuffer.trim()) {
              try {
                const event = JSON.parse(outputBuffer);
                this.broadcast({ type: 'sdk_event', event });
                if (event.type === 'result') {
                  finalContent = event.result || finalContent;
                }
              } catch {
                // Skip malformed data
              }
            }
          }
        }

        // Save final message and notify completion
        const responseContent = finalContent || '(no response)';
        const assistantMsg = this.addMessage('assistant', responseContent);
        this.broadcast({ type: 'message', message: assistantMsg });

        // Auto-title on first message
        if (data.autoTitle && data.threadId && data.org) {
          const title = data.content.slice(0, 30) + (data.content.length > 30 ? '...' : '');
          const indexId = this.env.CHAT_INDEX.idFromName(data.org);
          const indexStub = this.env.CHAT_INDEX.get(indexId);
          await indexStub.updateThread(data.threadId, title);
        }
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
      ws.send(JSON.stringify({ type: 'error', error: String(e) }));
    }
  }

  async webSocketClose(_ws: WebSocket) {
    // Connection closed
  }

  async webSocketError(_ws: WebSocket) {
    // Connection error
  }

  private broadcast(data: unknown) {
    const msg = JSON.stringify(data);
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(msg);
      } catch {
        // Client disconnected
      }
    }
  }

  // RPC methods for non-WebSocket access
  getMessages(): Message[] {
    const threadId = this.ctx.id.toString();
    return this.sql.exec('SELECT id, ? as thread_id, role, content, created_at FROM messages ORDER BY created_at ASC', threadId).toArray() as unknown as Message[];
  }

  addMessage(role: string, content: string): Message {
    const id = crypto.randomUUID();
    const now = Date.now();
    const threadId = this.ctx.id.toString();
    this.sql.exec('INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)', id, role, content, now);
    return { id, thread_id: threadId, role: role as 'user' | 'assistant', content, created_at: now };
  }

  deleteAllMessages(): boolean {
    this.sql.exec('DELETE FROM messages');
    return true;
  }
}
