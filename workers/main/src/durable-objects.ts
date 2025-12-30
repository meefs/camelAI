import { DurableObject } from 'cloudflare:workers';
import { getSandbox, parseSSEStream, type Sandbox, type LogEvent, type Process } from '@cloudflare/sandbox';
import { getTempR2Credentials, type TempCredentials } from './r2-credentials';
import { createApiToken, deleteApiToken } from './api-tokens';
import type { OrgDO } from './auth';

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
  project_id: string;
  created_by: string;
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
  ORG: DurableObjectNamespace<OrgDO>;
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

  createThread(title: string | undefined, projectId: string, createdBy?: string): Thread {
    const resolvedProjectId = projectId.trim();
    const project = resolvedProjectId ? this.getProject(resolvedProjectId) : null;
    if (!project) {
      throw new Error('Project not found');
    }
    const id = crypto.randomUUID();
    const now = Date.now();
    const t = title || 'New Chat';
    const creator = createdBy?.trim() || project.created_by || 'system';
    this.sql.exec(
      'INSERT INTO threads (id, title, project_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      id,
      t,
      resolvedProjectId,
      creator,
      now,
      now
    );
    return {
      id,
      title: t,
      project_id: resolvedProjectId,
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
  private initialized = false;
  // Persistent state (loaded from SQL, survives hibernation)
  private claudeSessionId: string | null = null;
  private deployToken: string | null = null;
  private deployScriptName: string | null = null;
  private projectId: string | null = null;
  private threadId: string | null = null;
  // Transient state (lost on hibernation, restored from storage or recreated)
  private currentProcessId: string | null = null;
  private currentProxyToken: string | null = null;
  private currentOrg: string | null = null;
  private sandbox: ReturnType<typeof getSandbox> | null = null;
  private chiridionBaseUrl: string | null = null;
  private chiridionSessionId: string | null = null;
  // Track sandbox warming to prevent duplicate warm-ups from React StrictMode double-mount
  // These are intentionally transient - we re-warm after hibernation
  private warmingPromise: Promise<void> | null = null;
  private warmedForOrg: string | null = null;
  // Track if log streaming is active to prevent duplicate streams
  private isStreamingLogs = false;

  constructor(ctx: DurableObjectState, env: ChatEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    // Use blockConcurrencyWhile for one-time initialization
    // This only runs once when the DO is first created, not on every hibernation wake
    ctx.blockConcurrencyWhile(async () => {
      await this.initialize();
    });
  }

  private async initialize() {
    if (this.initialized) return;

    // Run schema migrations
    this.migrate();

    // Load persistent state from metadata
    this.loadPersistentState();

    // Check for orphaned process state and clean up
    await this.cleanupOrphanedState();

    this.initialized = true;
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
      this.sql.exec('DROP TABLE IF EXISTS messages');
      this.sql.exec('DROP TABLE IF EXISTS metadata');
      this.sql.exec(`
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);
      this.sql.exec(`
        CREATE TABLE metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
      this.sql.exec('INSERT INTO _schema_version (version) VALUES (1)');
    }
  }

  private loadPersistentState() {
    // Load all metadata in a single query for efficiency
    const allRows = this.sql.exec<{ key: string; value: string }>('SELECT key, value FROM metadata').toArray();
    const metadata = new Map(allRows.map(r => [r.key, r.value]));

    this.claudeSessionId = metadata.get('claude_session_id') ?? null;
    this.deployToken = metadata.get('deploy_token') ?? null;
    this.deployScriptName = metadata.get('deploy_script_name') ?? null;
    this.projectId = metadata.get('project_id') ?? null;
    this.threadId = metadata.get('thread_id') ?? null;
    // Transient state for hibernation recovery
    this.currentOrg = metadata.get('current_org') ?? null;
    this.currentProcessId = metadata.get('current_process_id') ?? null;
    this.currentProxyToken = metadata.get('current_proxy_token') ?? null;
  }

  private async cleanupOrphanedState() {
    // Clean up orphaned proxy tokens - they expire anyway but good hygiene
    if (this.currentProxyToken) {
      try {
        await deleteApiToken(this.env.API_TOKENS, this.currentProxyToken);
      } catch {
        // Token may have already expired
      }
      this.currentProxyToken = null;
      this.sql.exec('DELETE FROM metadata WHERE key = ?', 'current_proxy_token');
    }
    // NOTE: Don't clear currentProcessId here - the ws-server process may still be running
    // We'll verify it via health check when a WebSocket connection comes in
  }

  private persistTransientState() {
    // Persist transient state that we want to recover after hibernation
    if (this.currentOrg) {
      this.sql.exec('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', 'current_org', this.currentOrg);
    }
    if (this.currentProcessId) {
      this.sql.exec('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', 'current_process_id', this.currentProcessId);
    }
    if (this.currentProxyToken) {
      this.sql.exec('INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)', 'current_proxy_token', this.currentProxyToken);
    }
  }

  private clearTransientState() {
    this.sql.exec('DELETE FROM metadata WHERE key IN (?, ?, ?)', 'current_org', 'current_process_id', 'current_proxy_token');
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

    // Persist mappings in KV:
    // 1. token -> script_name (for CF API proxy to override script name)
    // 2. script_name -> org (for outbound worker to route integration requests)
    // 3. token -> thread_id (for CF API proxy to notify DO on deploy success)
    const tokenKv = this.env.PLATFORM_SCRIPT_TOKENS ?? this.env.EMAIL_TO_USER;
    await tokenKv.put(`platform_script_token:${this.deployToken}`, this.deployScriptName);

    if (this.threadId) {
      await tokenKv.put(`deploy_token_thread:${this.deployToken}`, this.threadId);
    }

    if (this.currentOrg) {
      await tokenKv.put(`script_to_org:${this.deployScriptName}`, this.currentOrg);
      console.log('[DO] Stored script->org mapping:', this.deployScriptName, '->', this.currentOrg);
    }
  }

  /**
   * Mint a short-lived API token for integration proxy access.
   * This token is passed to the container so it can make authenticated
   * requests to external APIs via our proxy.
   */
  private async mintIntegrationProxyToken(
    orgId: string,
    integrationId: string | null
  ): Promise<string | null> {
    try {
      const result = await createApiToken(this.env.API_TOKENS, {
        orgId,
        userId: 'sandbox', // system user for sandbox tokens
        name: 'sandbox-proxy-token',
        scopes: ['proxy'],
        integrationId,
        expiresAt: Date.now() + 60 * 60 * 1000, // 1 hour TTL
      });
      return result.tokenId;
    } catch (e) {
      console.error('[DO] Failed to mint integration proxy token:', e);
      return null;
    }
  }

  /**
   * Expire the current proxy token immediately.
   * Called when the sandbox process exits.
   */
  private async expireProxyToken(): Promise<void> {
    if (!this.currentProxyToken) return;
    try {
      await deleteApiToken(this.env.API_TOKENS, this.currentProxyToken);
      console.log('[DO] Expired proxy token:', this.currentProxyToken.slice(0, 12) + '...');
      this.currentProxyToken = null;
    } catch (e) {
      console.error('[DO] Failed to expire proxy token:', e);
    }
  }

  // WebSocket handling - proxies directly to container via wsConnect
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

    // Accept WebSocket upgrades - proxy directly to container
    if (request.headers.get('Upgrade') === 'websocket') {
      this.currentOrg = org;

      this.chiridionBaseUrl =
        getExternalOriginFromHeaders(request, url);

      this.chiridionSessionId =
        request.headers.get(CHIRIDION_SESSION_HEADER) ??
        getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);

      await this.ensureDeployToken();

      // Get sandbox reference
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);

      // Check if WS server is already running (survives DO hibernation)
      // Always check health endpoint - processId may be null after hibernation
      // but the container/process could still be running
      const alreadyReady = await this.checkWsServerReady();

      if (!alreadyReady) {
        const process = await this.startWsServerProcess(org);
        if (!process) {
          console.error('[DO] Failed to start container');
          return new Response('Failed to start container', { status: 500 });
        }

        // Start log streaming immediately to capture startup errors
        this.ctx.waitUntil(this.streamLogsForPersistence(process.id));

        // Wait for the WS server to be ready by watching for startup log
        try {
          await process.waitForLog('[ws-server] Listening', 30000); // 30s timeout
        } catch (e) {
          console.error('[DO] Container WS server failed to start:', e);
          return new Response('Container WS server failed to start', { status: 500 });
        }
      } else if (this.currentProcessId && !this.isStreamingLogs) {
        // Reusing existing process - ensure log streaming is running
        // (it may have stopped when DO hibernated)
        // Only start if not already streaming to prevent duplicate log processing
        this.ctx.waitUntil(this.streamLogsForPersistence(this.currentProcessId));
      }

      // EXPERIMENT: Test if ctx.waitUntil tasks run after wsConnect
      this.ctx.waitUntil((async () => {
        for (let i = 1; i <= 20; i++) {
          await new Promise(r => setTimeout(r, 2000));
          console.log(`[EXPERIMENT] Timer tick ${i} after wsConnect (${i * 2}s elapsed)`);
        }
        console.log('[EXPERIMENT] Timer completed all 20 ticks');
      })());

      // Proxy WebSocket directly to container port 8080
      console.log('[EXPERIMENT] About to call wsConnect');
      const wsResponse = this.sandbox.wsConnect(request, 8080);
      console.log('[EXPERIMENT] wsConnect returned, returning response');
      return wsResponse;
    }

    return new Response('Not found', { status: 404 });
  }

  // Start the WebSocket server process in the container
  private async startWsServerProcess(org: string): Promise<Process | null> {
    try {
      const processEnv: Record<string, string> = {
        ANTHROPIC_API_KEY: this.env.ANTHROPIC_API_KEY,
      };

      // Resume existing Claude session if we have one
      if (this.claudeSessionId) {
        processEnv.RESUME_SESSION_ID = this.claudeSessionId;
      }

      if (this.env.R2_BUCKET_NAME) processEnv.R2_BUCKET_NAME = this.env.R2_BUCKET_NAME;
      if (this.env.R2_ACCOUNT_ID) processEnv.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
      if (this.env.R2_MOUNT_DIR) processEnv.R2_MOUNT_DIR = this.env.R2_MOUNT_DIR;
      if (this.env.R2_MOUNT_READONLY) processEnv.R2_MOUNT_READONLY = this.env.R2_MOUNT_READONLY;

      if (this.chiridionBaseUrl) processEnv.CHIRIDION_BASE_URL = this.chiridionBaseUrl;
      if (this.chiridionBaseUrl) processEnv.CLOUDFLARE_API_BASE_URL = `${this.chiridionBaseUrl.replace(/\/+$/, '')}/client/v4`;
      if (this.chiridionSessionId) processEnv.CHIRIDION_SESSION_ID = this.chiridionSessionId;
      if (this.threadId) processEnv.THREAD_ID = this.threadId;
      if (org) processEnv.ORG_ID = org;

      // Configure Wrangler
      if (this.deployToken) processEnv.CLOUDFLARE_API_TOKEN = this.deployToken;
      if (this.env.CF_ACCOUNT_ID) processEnv.CLOUDFLARE_ACCOUNT_ID = this.env.CF_ACCOUNT_ID;
      processEnv.WRANGLER_SEND_METRICS = 'false';
      processEnv.CI = '1';

      // Generate prefix-scoped temp credentials
      const projectId = await this.ensureProjectId(org);
      if (!projectId) {
        console.error('[DO] Missing project_id for thread');
        return null;
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
          86400
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

      // Mint integration proxy token
      const proxyToken = await this.mintIntegrationProxyToken(org, null);
      if (proxyToken && this.chiridionBaseUrl) {
        this.currentProxyToken = proxyToken;
        processEnv.CHIRIDION_PROXY_TOKEN = proxyToken;
        processEnv.CHIRIDION_PROXY_BASE_URL = this.chiridionBaseUrl;
        processEnv.CHIRIDION_ORG_ID = org;
      }

      // Start the WS server process
      const process = await this.sandbox!.startProcess('sh /app/run-ws-server.sh', { env: processEnv });
      this.currentProcessId = process.id;
      this.persistTransientState();
      return process;
    } catch (e) {
      console.error('[DO] Failed to start WS server process:', e);
      return null;
    }
  }

  // Single health check to see if WS server is already running
  private async checkWsServerReady(): Promise<boolean> {
    try {
      // Use exec+curl because sandbox.fetch() routes through control plane, not to port 8080
      const result = await this.sandbox!.exec('curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/health', {
        timeout: 2000
      });
      return result.stdout?.trim() === '200';
    } catch {
      return false;
    }
  }


  // Stream container logs in background for message persistence
  private async streamLogsForPersistence(processId: string): Promise<void> {
    if (this.isStreamingLogs) {
      return;
    }
    this.isStreamingLogs = true;

    try {
      const logStream = await this.sandbox!.streamProcessLogs(processId);
      let outputBuffer = '';
      let stderrBuffer = '';
      const PERSIST_PREFIX = '[PERSIST]';

      for await (const logEvent of parseSSEStream<LogEvent>(logStream)) {
        // Parse persistence events from stderr (prefixed with [PERSIST])
        // Note: stdout may not be captured correctly in Cloudflare Container environments
        if (logEvent.type === 'stderr' && logEvent.data) {
          stderrBuffer += logEvent.data;
          const lines = stderrBuffer.split('\n');
          stderrBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;

            // Check for persistence events
            if (line.startsWith(PERSIST_PREFIX)) {
              try {
                const jsonStr = line.slice(PERSIST_PREFIX.length);
                const event = JSON.parse(jsonStr);

                // Persist user messages (use ID from log event for dedup)
                if (event.type === 'user_message' && event.id) {
                  this.addMessageWithId(event.id, 'user', event.content);
                  console.log('[DO] Persisted user message:', event.id);
                }

                // Persist assistant messages (use ID from log event for dedup)
                if (event.type === 'assistant_message' && event.id) {
                  this.addMessageWithId(event.id, 'assistant', event.content);
                  console.log('[DO] Persisted assistant message:', event.id);
                }

                // Store session ID
                if (event.type === 'session_id') {
                  this.claudeSessionId = event.sessionId;
                  this.sql.exec(
                    'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
                    'claude_session_id',
                    event.sessionId
                  );
                  console.log('[DO] Stored Claude session ID:', event.sessionId);
                }
              } catch {
                // Skip malformed lines
              }
            } else {
              // Regular stderr logging
              console.log('[Container]', line.trim());
            }
          }
        }

        // Also check stdout for backwards compatibility
        if (logEvent.type === 'stdout' && logEvent.data) {
          outputBuffer += logEvent.data;
          const lines = outputBuffer.split('\n');
          outputBuffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            try {
              const event = JSON.parse(line);

              // Persist user messages (use ID from log event for dedup)
              if (event.type === 'user_message' && event.id) {
                this.addMessageWithId(event.id, 'user', event.content);
              }

              // Persist assistant messages (use ID from log event for dedup)
              if (event.type === 'assistant_message' && event.id) {
                this.addMessageWithId(event.id, 'assistant', event.content);
              }

              // Store session ID
              if (event.type === 'session_id') {
                this.claudeSessionId = event.sessionId;
                this.sql.exec(
                  'INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)',
                  'claude_session_id',
                  event.sessionId
                );
              }
            } catch {
              // Skip malformed lines
            }
          }
        }

        if (logEvent.type === 'exit') {
          // Clean up
          await this.expireProxyToken();
          this.currentProcessId = null;
          this.isStreamingLogs = false;
          this.clearTransientState();
        }
      }
    } catch (e) {
      console.error('[DO] Log streaming error:', e);
    } finally {
      this.isStreamingLogs = false;
    }
  }

  // NOTE: With wsConnect(), WebSocket is proxied directly to container
  // These handlers are not called for proxied connections, but kept for interface compliance
  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer) {
    // Not used with wsConnect() - messages go directly to container
  }

  async webSocketClose(_ws: WebSocket) {
    // Not used with wsConnect()
  }

  async webSocketError(_ws: WebSocket) {
    // Not used with wsConnect()
  }

  // RPC methods for non-WebSocket access
  getMessages(): Message[] {
    const threadId = this.ctx.id.toString();
    return this.sql.exec('SELECT id, ? as thread_id, role, content, created_at FROM messages ORDER BY created_at ASC', threadId).toArray() as unknown as Message[];
  }

  /**
   * Add a message with a specific ID (used by log streaming for dedup).
   * Returns null if the ID already exists (log replay).
   */
  addMessageWithId(id: string, role: string, content: string): Message | null {
    const threadId = this.ctx.id.toString();

    // Check if this exact ID already exists (dedup log replays)
    const existing = this.sql.exec<{ id: string }>(
      'SELECT id FROM messages WHERE id = ?',
      id
    ).toArray();

    if (existing.length > 0) {
      return null; // Already persisted, skip silently
    }

    const now = Date.now();
    this.sql.exec('INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)', id, role, content, now);
    return { id, thread_id: threadId, role: role as 'user' | 'assistant', content, created_at: now };
  }

  /**
   * Add a message with auto-generated ID (used by RPC for external callers).
   */
  addMessage(role: string, content: string): Message {
    const threadId = this.ctx.id.toString();
    const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    this.sql.exec('INSERT INTO messages (id, role, content, created_at) VALUES (?, ?, ?, ?)', id, role, content, now);
    return { id, thread_id: threadId, role: role as 'user' | 'assistant', content, created_at: now };
  }

  deleteAllMessages(): boolean {
    this.sql.exec('DELETE FROM messages');
    return true;
  }

  /**
   * Called by the CF API proxy when a wrangler deploy succeeds.
   * Sends deploy_success event to the container which forwards it to the WebSocket client.
   */
  async notifyDeploySuccess(scriptName: string): Promise<void> {
    console.log('[DO] Deploy success notification for script:', scriptName);

    // Ensure we have a sandbox reference
    if (!this.sandbox) {
      const sandboxId = this.ctx.id.toString().slice(0, 63);
      this.sandbox = getSandbox(this.env.SANDBOX, sandboxId);
    }

    // Use exec + curl because sandbox.fetch() routes through control plane, not to port 8080
    try {
      const payload = JSON.stringify({
        type: 'deploy_success',
        scriptName,
        timestamp: Date.now(),
      });
      // Escape single quotes in payload for shell
      const escapedPayload = payload.replace(/'/g, "'\\''");
      const result = await this.sandbox.exec(
        `curl -s -X POST -H 'Content-Type: application/json' -d '${escapedPayload}' http://localhost:8080/broadcast`,
        { timeout: 5000 }
      );
      if (result.exitCode !== 0) {
        console.error('[DO] Failed to broadcast deploy success:', result.stderr);
      }
    } catch (e) {
      console.error('[DO] Error broadcasting deploy success:', e);
    }
  }
}
