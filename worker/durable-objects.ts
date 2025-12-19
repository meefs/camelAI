import { DurableObject } from 'cloudflare:workers';
import { getSandbox, parseSSEStream, type Sandbox, type LogEvent } from '@cloudflare/sandbox';
import { proxyCloudflareApiInternal } from './cf-api-proxy.js';
import { getTempR2Credentials, type TempCredentials } from './r2-credentials';

const SANDBOX_TUNNEL_PORT = 8787;
const SANDBOX_TUNNEL_COMMAND = 'bun /app/tunnel-server.mjs';
const SANDBOX_API_FAKE_TOKEN = 'sandbox-tunnel';

export interface Thread {
  id: string;
  title: string;
  project_id: string;
  created_at: number;
  updated_at: number;
}

export interface Project {
  id: string;
  name: string;
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
}

// One DO per org - stores thread list only
export class ChatIndexDO extends DurableObject<ChatEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    try {
      this.sql.exec('ALTER TABLE threads ADD COLUMN project_id TEXT');
    } catch {
      // Column already exists.
    }
    try {
      this.sql.exec('ALTER TABLE projects ADD COLUMN created_by TEXT');
    } catch {
      // Column already exists.
    }
    this.sql.exec('CREATE INDEX IF NOT EXISTS projects_created_by ON projects(created_by)');
    try {
      const missing = this.sql.exec(
        'SELECT id FROM threads WHERE project_id IS NULL OR project_id = ? LIMIT 1',
        ''
      ).toArray() as { id: string }[];
      if (missing.length > 0) {
        const migratedProjectId = this.ensureMigrationProject();
        this.sql.exec(
          'UPDATE threads SET project_id = ? WHERE project_id IS NULL OR project_id = ?',
          migratedProjectId,
          ''
        );
      }
    } catch {
      // Ignore if the column is not available yet.
    }
    try {
      this.sql.exec('UPDATE projects SET created_by = ? WHERE created_by IS NULL OR created_by = ?', 'system', '');
    } catch {
      // Ignore if the column is not available yet.
    }
  }

  private ensureMigrationProject(): string {
    const rows = this.sql.exec(
      'SELECT id FROM projects WHERE name = ? AND created_by = ? LIMIT 1',
      'Migrated Threads',
      'system'
    ).toArray() as { id: string }[];
    if (rows.length > 0) return rows[0].id;
    return this.createProject('Migrated Threads', 'system').id;
  }

  getProjects(): Project[] {
    return this.sql.exec('SELECT * FROM projects ORDER BY updated_at DESC').toArray() as unknown as Project[];
  }

  getProjectsByUser(userId: string): Project[] {
    const rows = this.sql.exec(
      'SELECT * FROM projects WHERE created_by = ? ORDER BY updated_at DESC',
      userId
    ).toArray() as unknown as Project[];
    return rows;
  }

  createProject(name?: string, createdBy?: string): Project {
    const id = crypto.randomUUID();
    const now = Date.now();
    const projectName = name?.trim() || 'New Project';
    const creator = createdBy?.trim() || 'system';
    this.sql.exec(
      'INSERT INTO projects (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      projectName,
      creator,
      now,
      now
    );
    return {
      id,
      name: projectName,
      created_by: creator,
      created_at: now,
      updated_at: now,
    };
  }

  getProject(id: string): Project | null {
    const rows = this.sql.exec('SELECT * FROM projects WHERE id = ?', id).toArray() as unknown as Project[];
    return rows[0] || null;
  }

  updateProject(id: string, name: string): Project | null {
    const now = Date.now();
    this.sql.exec('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?', name, now, id);
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    const rows = this.sql.exec(
      'SELECT COUNT(*) as count FROM threads WHERE project_id = ?',
      id
    ).toArray() as Array<{ count: number }>;
    if ((rows[0]?.count ?? 0) > 0) {
      throw new Error('Project has threads');
    }
    this.sql.exec('DELETE FROM projects WHERE id = ?', id);
    return true;
  }

  getThreads(): Thread[] {
    return this.sql.exec('SELECT * FROM threads ORDER BY updated_at DESC').toArray() as unknown as Thread[];
  }

  createThread(title: string | undefined, projectId: string): Thread {
    const resolvedProjectId = projectId.trim();
    const project = resolvedProjectId ? this.getProject(resolvedProjectId) : null;
    if (!project) {
      throw new Error('Project not found');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = title || 'New Chat';
    this.sql.exec(
      'INSERT INTO threads (id, title, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
      id,
      t,
      resolvedProjectId,
      now,
      now
    );
    return { id, title: t, project_id: resolvedProjectId, created_at: now, updated_at: now };
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

  setThreadProject(id: string, projectId: string): Thread | null {
    this.sql.exec('UPDATE threads SET project_id = ? WHERE id = ?', projectId, id);
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
  private deployScriptName: string | null = null;
  private projectId: string | null = null;
  private threadId: string | null = null;
  private sandboxTunnelSocket: WebSocket | null = null;
  private sandboxTunnelPromise: Promise<WebSocket | null> | null = null;

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

    const scriptRows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'deploy_script_name').toArray();
    if (scriptRows.length > 0) {
      this.deployScriptName = (scriptRows[0] as { value: string }).value;
    }

    const projectRows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'project_id').toArray();
    if (projectRows.length > 0) {
      this.projectId = (projectRows[0] as { value: string }).value;
    }
    const threadRows = this.sql.exec('SELECT value FROM metadata WHERE key = ?', 'thread_id').toArray();
    if (threadRows.length > 0) {
      this.threadId = (threadRows[0] as { value: string }).value;
    }
  }

  private async ensureProjectId(org: string): Promise<string | null> {
    if (this.projectId) return this.projectId;
    if (!this.threadId) {
      console.error('[DO] Missing thread_id; cannot resolve project');
      return null;
    }
    const indexStub = this.env.CHAT_INDEX.get(this.env.CHAT_INDEX.idFromName(org));
    const thread = await indexStub.getThread(this.threadId);
    if (!thread) {
      console.error('[DO] Missing thread in index; cannot resolve project', this.threadId);
      return null;
    }
    if (!thread.project_id) {
      console.error('[DO] Thread missing project_id; refusing to start', this.threadId);
      return null;
    }
    this.projectId = thread.project_id;
    this.sql.exec(
      'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
      'project_id',
      this.projectId
    );
    return this.projectId;
  }

  private async ensureDeployScriptName(): Promise<void> {
    if (!this.deployScriptName) {
      this.deployScriptName = `wfp-${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
      this.sql.exec(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        'deploy_script_name',
        this.deployScriptName
      );
    }
  }

  private async ensureSandboxTunnel(org: string): Promise<void> {
    if (this.sandboxTunnelPromise) {
      await this.sandboxTunnelPromise;
      return;
    }
    if (this.sandboxTunnelSocket && this.sandboxTunnelSocket.readyState === WebSocket.OPEN) {
      return;
    }

    this.sandboxTunnelPromise = (async () => {
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);
      await this.ensureSandboxTunnelServer();

      const request = new Request('http://sandbox-tunnel', {
        headers: {
          Upgrade: 'websocket',
          Connection: 'Upgrade',
        },
      });

      const response = await this.sandbox.wsConnect(request, SANDBOX_TUNNEL_PORT);
      const ws = response.webSocket;
      if (!ws) {
        throw new Error('Sandbox tunnel wsConnect failed: missing WebSocket');
      }

      ws.accept();
      ws.addEventListener('message', (event) => {
        void this.handleSandboxTunnelMessage(ws, event.data);
      });
      ws.addEventListener('close', () => {
        if (this.sandboxTunnelSocket === ws) this.sandboxTunnelSocket = null;
      });
      ws.addEventListener('error', () => {
        if (this.sandboxTunnelSocket === ws) this.sandboxTunnelSocket = null;
      });

      this.sandboxTunnelSocket = ws;
      const projectId = await this.ensureProjectId(org);
      ws.send(
        JSON.stringify({
          type: 'tunnel_init',
          threadId: this.threadId,
          projectId,
          org,
        })
      );
      return ws;
    })();

    try {
      await this.sandboxTunnelPromise;
    } finally {
      this.sandboxTunnelPromise = null;
    }
  }

  private async ensureSandboxTunnelServer(): Promise<void> {
    if (!this.sandbox) return;
    try {
      const processes = await this.sandbox.listProcesses();
      const existing = processes.find((proc) => {
        return (
          proc.command.includes('/app/tunnel-server.mjs') &&
          (proc.status === 'starting' || proc.status === 'running')
        );
      });

      if (existing) {
        if (existing.status === 'starting') {
          await existing.waitForPort(SANDBOX_TUNNEL_PORT, { mode: 'tcp', timeout: 60_000 });
        }
        return;
      }

      const process = await this.sandbox.startProcess(SANDBOX_TUNNEL_COMMAND, {
        env: { SANDBOX_TUNNEL_PORT: String(SANDBOX_TUNNEL_PORT) },
      });
      await process.waitForPort(SANDBOX_TUNNEL_PORT, { mode: 'tcp', timeout: 60_000 });
    } catch (e) {
      console.warn('[DO] Failed to start sandbox tunnel server:', e);
    }
  }

  private async handleSandboxTunnelMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    try {
      const data = JSON.parse(text);
      if (data?.type === 'emit' && data.event) {
        this.broadcast({ type: 'sandbox_emit', event: data.event });
        return;
      }
      if (data?.type === 'cf_api_request' && data.id) {
        await this.handleCfApiProxyRequest(ws, data);
        return;
      }
      if (data?.type === 'tunnel_ready') {
        console.log('[DO] Sandbox tunnel ready');
      } else if (data?.type === 'tunnel_ack') {
        console.log('[DO] Sandbox tunnel acknowledged');
      }
    } catch {
      // Ignore malformed messages.
    }
  }

  private async handleCfApiProxyRequest(ws: WebSocket, data: Record<string, unknown>) {
    try {
      await this.ensureDeployScriptName();
      const method = typeof data.method === 'string' ? data.method : 'GET';
      const path = typeof data.path === 'string' ? data.path : '/';
      const search = typeof data.search === 'string' ? data.search : '';
      const headersInput = typeof data.headers === 'object' && data.headers ? data.headers : {};
      const headers = new Headers(headersInput as Record<string, string>);

      let body: ArrayBuffer | undefined;
      if (typeof data.body === 'string' && data.body.length > 0) {
        const binary = atob(data.body);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) {
          bytes[i] = binary.charCodeAt(i);
        }
        body = bytes.buffer;
      }

      const url = new URL(path + search, 'http://sandbox-tunnel');
      const proxyRequest = new Request(url.toString(), {
        method,
        headers,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
      });
      const response = await proxyCloudflareApiInternal(proxyRequest, this.env, this.deployScriptName);
      const responseBody = await response.arrayBuffer();
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const bytes = new Uint8Array(responseBody);
      let binary = '';
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
      }
      const bodyBase64 = binary ? btoa(binary) : '';

      ws.send(
        JSON.stringify({
          type: 'cf_api_response',
          id: data.id,
          status: response.status,
          headers: responseHeaders,
          body: bodyBase64,
        })
      );
    } catch (e) {
      ws.send(
        JSON.stringify({
          type: 'cf_api_response',
          id: data.id,
          status: 502,
          headers: { 'content-type': 'text/plain' },
          body: btoa(`proxy error: ${String(e)}`),
        })
      );
    }
  }

  // WebSocket handling
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const org = url.searchParams.get('org') || 'default';
    const pathParts = url.pathname.split('/').filter(Boolean);
    const threadId = pathParts[pathParts.length - 1] || null;
    if (threadId && !this.threadId) {
      this.threadId = threadId;
      this.sql.exec(
        'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
        'thread_id',
        threadId
      );
    }

    // Accept WebSocket upgrades regardless of the path (the Worker selects the DO instance).
    if (request.headers.get('Upgrade') === 'websocket') {

      await this.ensureDeployScriptName();

      // Persist env vars at the sandbox/container level so any subsequent processes (not just the
      // Claude driver) inherit the Wrangler proxy configuration.
      try {
        const sandboxId = this.ctx.id.toString().slice(0, 63);
        this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);
        const envVars: Record<string, string> = {
          WRANGLER_SEND_METRICS: 'false',
          CI: '1',
          SANDBOX_TUNNEL_PORT: String(SANDBOX_TUNNEL_PORT),
        };
        const projectId = await this.ensureProjectId(org);
        if (projectId) envVars.PROJECT_ID = projectId;
        envVars.CLOUDFLARE_API_BASE_URL = `http://127.0.0.1:${SANDBOX_TUNNEL_PORT}/client/v4`;
        envVars.CLOUDFLARE_API_TOKEN = SANDBOX_API_FAKE_TOKEN;
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

      const projectId = await this.ensureProjectId(org);
      if (!projectId) {
        console.error('[DO] Missing project_id for thread; refusing to warm sandbox');
        return;
      }
      processEnv.PROJECT_ID = projectId;
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
        if (data.threadId && !this.threadId) {
          this.threadId = data.threadId;
          this.sql.exec(
            'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
            'thread_id',
            this.threadId
          );
        }
        // Save user message
        const userMsg = this.addMessage('user', data.content);
        this.broadcast({ type: 'message', message: userMsg });

        // Get sandbox for this thread
        const sandboxId = this.ctx.id.toString().slice(0, 63);
        this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);
        try {
          await this.ensureSandboxTunnel(data.org || 'default');
        } catch (e) {
          console.warn('[DO] Sandbox tunnel unavailable:', e);
        }

        // Start Claude SDK driver as a background process
        console.log('[DO] API key present:', !!this.env.ANTHROPIC_API_KEY, 'length:', this.env.ANTHROPIC_API_KEY?.length);
        const processEnv: Record<string, string> = {
          ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
          CLAUDE_PROMPT: data.content,
          SANDBOX_TUNNEL_PORT: String(SANDBOX_TUNNEL_PORT),
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

        // Configure Wrangler to use the sandbox tunnel for Cloudflare API calls.
        processEnv.CLOUDFLARE_API_BASE_URL = `http://127.0.0.1:${SANDBOX_TUNNEL_PORT}/client/v4`;
        processEnv.CLOUDFLARE_API_TOKEN = SANDBOX_API_FAKE_TOKEN;
        if (this.env.CF_ACCOUNT_ID) processEnv.CLOUDFLARE_ACCOUNT_ID = this.env.CF_ACCOUNT_ID;
        processEnv.WRANGLER_SEND_METRICS = 'false';
        processEnv.CI = '1';

        // Generate prefix-scoped temp credentials (required for R2 access)
        const org = data.org || 'default';
        const projectId = await this.ensureProjectId(org);
        if (!projectId) {
          throw new Error('Missing project_id for thread');
        }
        processEnv.PROJECT_ID = projectId;
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
