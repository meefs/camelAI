import { DurableObject } from 'cloudflare:workers';
import { getSandbox, parseSSEStream, type Sandbox, type LogEvent } from '@cloudflare/sandbox';
import { getTempR2Credentials, type TempCredentials } from './r2-credentials';

const SESSION_COOKIE_NAME = 'chiridion_session';
const CHIRIDION_SESSION_HEADER = 'X-Chiridion-Session-Id';

function getExternalOriginFromHeaders(request: Request, fallbackUrl: URL): string {
  const forwardedProtoRaw = request.headers.get('x-forwarded-proto');
  const forwardedProto = forwardedProtoRaw ? forwardedProtoRaw.split(',')[0]?.trim() : null;
  const forwardedHostRaw = request.headers.get('x-forwarded-host');
  const forwardedHost = forwardedHostRaw ? forwardedHostRaw.split(',')[0]?.trim() : null;

  let proto = forwardedProto;
  if (!proto) {
    const cfVisitor = request.headers.get('cf-visitor');
    if (cfVisitor) {
      try {
        const parsed = JSON.parse(cfVisitor) as { scheme?: unknown };
        if (typeof parsed.scheme === 'string' && parsed.scheme) proto = parsed.scheme;
      } catch {
        // ignore
      }
    }
  }
  if (!proto) proto = fallbackUrl.protocol.replace(/:$/, '');
  if (!proto) proto = 'https';

  const host = forwardedHost || request.headers.get('host') || fallbackUrl.host;
  return `${proto}://${host}`;
}

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

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
  private claudeSessionId: string | null = null;
  private currentProcessId: string | null = null;
  private sandbox: ReturnType<typeof getSandbox> | null = null;
  private chiridionBaseUrl: string | null = null;
  private chiridionSessionId: string | null = null;
  private deployToken: string | null = null;
  private deployScriptName: string | null = null;

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
    // Load Claude's session ID if we have one from a previous conversation
    const rows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'claude_session_id').toArray();
    if (rows.length > 0) {
      this.claudeSessionId = (rows[0] as { value: string }).value;
    }

    const tokenRows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'deploy_token').toArray();
    if (tokenRows.length > 0) {
      this.deployToken = (tokenRows[0] as { value: string }).value;
    }
    const scriptRows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'deploy_script_name').toArray();
    if (scriptRows.length > 0) {
      this.deployScriptName = (scriptRows[0] as { value: string }).value;
    }
  }

  private async ensureDeployToken(): Promise<void> {
    if (!this.deployToken) {
      this.deployToken = crypto.randomUUID();
      this.sql.exec(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        'deploy_token',
        this.deployToken
      );
    }
    if (!this.deployScriptName) {
      this.deployScriptName = `wfp-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.sql.exec(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        'deploy_script_name',
        this.deployScriptName
      );
    }

    // Persist mapping in KV so the API proxy can override script_name for this token.
    const tokenKv = this.env.PLATFORM_SCRIPT_TOKENS ?? this.env.EMAIL_TO_USER;
    await tokenKv.put(`platform_script_token:${this.deployToken}`, this.deployScriptName);
  }

  // WebSocket handling
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // Accept WebSocket upgrades regardless of the path (the Worker selects the DO instance).
    if (request.headers.get('Upgrade') === 'websocket') {

      this.chiridionBaseUrl =
        getExternalOriginFromHeaders(request, url);

      this.chiridionSessionId =
        request.headers.get(CHIRIDION_SESSION_HEADER) ??
        getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);

      await this.ensureDeployToken();

      // Persist env vars at the sandbox/container level so any subsequent processes (not just the
      // Claude driver) inherit the Wrangler proxy configuration.
      try {
        const sandboxId = this.ctx.id.toString().slice(0, 63);
        this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);
        const envVars: Record<string, string> = {
          WRANGLER_SEND_METRICS: 'false',
          CI: '1',
        };
        if (this.chiridionBaseUrl) envVars.CHIRIDION_BASE_URL = this.chiridionBaseUrl;
        if (this.chiridionBaseUrl) envVars.CLOUDFLARE_API_BASE_URL = `${this.chiridionBaseUrl.replace(/\/+$/, '')}/client/v4`;
        if (this.deployToken) envVars.CLOUDFLARE_API_TOKEN = this.deployToken;
        if (this.env.CF_ACCOUNT_ID) envVars.CLOUDFLARE_ACCOUNT_ID = this.env.CF_ACCOUNT_ID;
        await this.sandbox.setEnvVars(envVars);
      } catch (e) {
        console.warn('[DO] Failed to persist sandbox env vars:', e);
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      this.ctx.acceptWebSocket(server);

      // Send existing messages on connect
      const messages = this.getMessages();
      server.send(JSON.stringify({ type: 'history', messages }));

      // Start warming up the sandbox in the background (don't await)
      const org = url.searchParams.get('org') || 'default';
      this.warmSandbox(org);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // Warm up the sandbox container and sync from R2
  private async warmSandbox(org: string) {
    try {
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      const sandbox = getSandbox(this.env.SANDBOX, sandboxId);
      this.sandbox = sandbox;

      // Build env for sync
      const processEnv: Record<string, string> = { SYNC_ONLY: '1' };

      if (this.env.R2_BUCKET_NAME) processEnv.R2_BUCKET_NAME = this.env.R2_BUCKET_NAME;
      if (this.env.R2_ACCOUNT_ID) processEnv.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
      if (this.env.R2_MOUNT_DIR) processEnv.R2_MOUNT_DIR = this.env.R2_MOUNT_DIR;

      const prefix = `${org}/`;
      processEnv.R2_PREFIX = prefix;

      // Generate temp credentials if configured
      if (this.env.R2_API_TOKEN && this.env.R2_PARENT_ACCESS_KEY_ID && this.env.R2_ACCOUNT_ID && this.env.R2_BUCKET_NAME) {
        const tempCreds = await getTempR2Credentials(
          this.env.R2_ACCOUNT_ID,
          this.env.R2_BUCKET_NAME,
          this.env.R2_PARENT_ACCESS_KEY_ID,
          this.env.R2_API_TOKEN,
          prefix,
          86400 // 24 hours
        );
        processEnv.AWS_ACCESS_KEY_ID = tempCreds.accessKeyId;
        processEnv.AWS_SECRET_ACCESS_KEY = tempCreds.secretAccessKey;
        processEnv.AWS_SESSION_TOKEN = tempCreds.sessionToken;

        // Ensure prefix exists
        const placeholderKey = `${prefix}.keep`;
        const existing = await this.env.R2_BUCKET.head(placeholderKey);
        if (!existing) {
          await this.env.R2_BUCKET.put(placeholderKey, '');
        }
      }

      // Run sync-only to download files from R2
      console.log('[DO] Warming sandbox with R2 sync for prefix:', prefix);
      await sandbox.exec('sh /app/run-driver.sh', { env: processEnv });
      console.log('[DO] Sandbox warm complete');
    } catch (e) {
      console.error('Failed to warm sandbox:', e);
    }
  }

  // Called when WebSocket message received
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    try {
      const data = JSON.parse(message as string);

      if (data.type === 'stop') {
        // Stop the current running process
        await this.stopCurrentProcess();
        this.broadcast({ type: 'stopped' });
        return;
      }

      if (data.type === 'message') {
        // Save user message
        const userMsg = this.addMessage('user', data.content);
        this.broadcast({ type: 'message', message: userMsg });

        // Get sandbox for this thread
        const sandboxId = this.ctx.id.toString().slice(0, 63);
        this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);

        // Start Claude SDK driver as a background process
        console.log('[DO] API key present:', !!this.env.ANTHROPIC_API_KEY, 'length:', this.env.ANTHROPIC_API_KEY?.length);
        const processEnv: Record<string, string> = {
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
          CLAUDE_PROMPT: data.content,
        };

        // Resume existing Claude session if we have one
        if (this.claudeSessionId) {
          processEnv.RESUME_SESSION_ID = this.claudeSessionId;
          console.log('[DO] Resuming Claude session:', this.claudeSessionId);
        }

        if (this.env.R2_BUCKET_NAME) processEnv.R2_BUCKET_NAME = this.env.R2_BUCKET_NAME;
        if (this.env.R2_ACCOUNT_ID) processEnv.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
        if (this.env.R2_MOUNT_DIR) processEnv.R2_MOUNT_DIR = this.env.R2_MOUNT_DIR;
        if (this.env.R2_MOUNT_READONLY) processEnv.R2_MOUNT_READONLY = this.env.R2_MOUNT_READONLY;

        if (this.chiridionBaseUrl) processEnv.CHIRIDION_BASE_URL = this.chiridionBaseUrl;
        if (this.chiridionSessionId) processEnv.CHIRIDION_SESSION_ID = this.chiridionSessionId;

        // Configure Wrangler to use our local Cloudflare API proxy and a per-sandbox deploy token.
        if (this.deployToken) processEnv.CLOUDFLARE_API_TOKEN = this.deployToken;
        if (this.env.CF_ACCOUNT_ID) processEnv.CLOUDFLARE_ACCOUNT_ID = this.env.CF_ACCOUNT_ID;
        processEnv.WRANGLER_SEND_METRICS = 'false';
        processEnv.CI = '1';

        // Generate prefix-scoped temp credentials (required for R2 access)
        const org = data.org || 'default';
        const prefix = `${org}/`;
        processEnv.R2_PREFIX = prefix;

        if (this.env.R2_API_TOKEN && this.env.R2_PARENT_ACCESS_KEY_ID && this.env.R2_ACCOUNT_ID && this.env.R2_BUCKET_NAME) {
          const tempCreds = await getTempR2Credentials(
            this.env.R2_ACCOUNT_ID,
            this.env.R2_BUCKET_NAME,
            this.env.R2_PARENT_ACCESS_KEY_ID,
            this.env.R2_API_TOKEN,
            prefix,
            86400 // 24 hours
          );
          console.log('[DO] Generated temp R2 credentials for prefix:', prefix);
          processEnv.AWS_ACCESS_KEY_ID = tempCreds.accessKeyId;
          processEnv.AWS_SECRET_ACCESS_KEY = tempCreds.secretAccessKey;
          processEnv.AWS_SESSION_TOKEN = tempCreds.sessionToken;

          // Ensure prefix exists in R2 by creating a placeholder object
          const placeholderKey = `${prefix}.keep`;
          const existing = await this.env.R2_BUCKET.head(placeholderKey);
          if (!existing) {
            await this.env.R2_BUCKET.put(placeholderKey, '');
            console.log('[DO] Created prefix placeholder:', placeholderKey);
          }
        }

        const process = await this.sandbox.startProcess('sh /app/run-driver.sh', { env: processEnv });

        this.currentProcessId = process.id;
        console.log('[DO] Started process:', process.id, 'PID:', process.pid);

        let finalContent = '';
        let outputBuffer = '';

        // Stream logs from the process
        const logStream = await this.sandbox.streamProcessLogs(process.id);

        // Process streaming log events
        for await (const logEvent of parseSSEStream<LogEvent>(logStream)) {
          console.log('[DO] logEvent:', logEvent.type, logEvent.data?.substring(0, 100));

          if (logEvent.type === 'stdout' && logEvent.data) {
            outputBuffer += logEvent.data;
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

                // Capture Claude's session ID from init event
                if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
                  if (!this.claudeSessionId) {
                    this.claudeSessionId = event.session_id;
                    this.sql.exec(
                      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
                      'claude_session_id',
                      event.session_id
                    );
                    console.log('[DO] Captured Claude session ID:', event.session_id);
                  }
                }

                // Track final content for saving
                if (event.type === 'assistant' && event.message?.content) {
                  const textBlock = event.message.content.find((b: { type: string }) => b.type === 'text');
                  if (textBlock?.text) {
                    finalContent = textBlock.text;
                  }
                } else if (event.type === 'result') {
                  finalContent = event.result || finalContent;
                  // Save message and notify completion immediately on result
                  const responseContent = finalContent || '(no response)';
                  const assistantMsg = this.addMessage('assistant', responseContent);
                  this.broadcast({ type: 'message', message: assistantMsg });
                  this.currentProcessId = null;

                  // Auto-title on first message
                  if (data.autoTitle && data.threadId && data.org) {
                    const title = data.content.slice(0, 30) + (data.content.length > 30 ? '...' : '');
                    const indexId = this.env.CHAT_INDEX.idFromName(data.org);
                    const indexStub = this.env.CHAT_INDEX.get(indexId);
                    indexStub.updateThread(data.threadId, title);
                  }
                  return; // Exit early, don't wait for stream to close
                }
              } catch {
                // Skip malformed lines
              }
            }
          } else if (logEvent.type === 'stderr' && logEvent.data) {
            console.log('Driver stderr:', logEvent.data);
          } else if (logEvent.type === 'exit') {
            // Process exited - process any remaining buffer
            console.log('[DO] Process exited');
            if (outputBuffer.trim()) {
              try {
                const event = JSON.parse(outputBuffer);
                this.broadcast({ type: 'sdk_event', event });
                if (event.type === 'result') {
                  finalContent = event.result || finalContent;
                  // Handle result in buffer same as above
                  const responseContent = finalContent || '(no response)';
                  const assistantMsg = this.addMessage('assistant', responseContent);
                  this.broadcast({ type: 'message', message: assistantMsg });
                  this.currentProcessId = null;
                  return;
                }
              } catch {
                // Skip malformed data
              }
            }
          }
        }

        // Fallback: if we get here without a result event, still complete
        this.currentProcessId = null;
        const responseContent = finalContent || '(no response)';
        const assistantMsg = this.addMessage('assistant', responseContent);
        this.broadcast({ type: 'message', message: assistantMsg });
      }
    } catch (e) {
      console.error('WebSocket message error:', e);
      this.currentProcessId = null;
      ws.send(JSON.stringify({ type: 'error', error: String(e) }));
    }
  }

  // Stop the currently running process
  private async stopCurrentProcess() {
    if (this.currentProcessId && this.sandbox) {
      try {
        console.log('[DO] Killing process:', this.currentProcessId);
        await this.sandbox.killProcess(this.currentProcessId);
        this.currentProcessId = null;
      } catch (e) {
        console.error('[DO] Failed to kill process:', e);
      }
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
