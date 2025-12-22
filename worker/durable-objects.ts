import { DurableObject } from 'cloudflare:workers';
import { getSandbox, parseSSEStream, type Sandbox, type LogEvent } from '@cloudflare/sandbox';
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
    // If we have a stored process ID from before hibernation, the process is likely dead
    // Clean up the orphaned proxy token
    if (this.currentProxyToken) {
      console.log('[DO] Cleaning up orphaned proxy token from pre-hibernation state');
      try {
        await deleteApiToken(this.env.API_TOKENS, this.currentProxyToken);
      } catch (e) {
        console.error('[DO] Failed to clean up orphaned proxy token:', e);
      }
      this.currentProxyToken = null;
      this.sql.exec('DELETE FROM metadata WHERE key = ?', 'current_proxy_token');
    }
    if (this.currentProcessId) {
      console.log('[DO] Clearing orphaned process ID from pre-hibernation state:', this.currentProcessId);
      this.currentProcessId = null;
      this.sql.exec('DELETE FROM metadata WHERE key = ?', 'current_process_id');
    }
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

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      // Log connection count to help debug React StrictMode double-mount
      const existingConnections = this.ctx.getWebSockets().length;
      if (existingConnections > 0) {
        console.log(`[DO] New WebSocket connection (${existingConnections} existing) - likely React StrictMode double-mount`);
      }

      this.ctx.acceptWebSocket(server);

      // Send existing messages on connect
      const messages = this.getMessages();
      server.send(JSON.stringify({ type: 'history', messages }));

      // Start warming up the sandbox in the background (don't await)
      // Deduplicates automatically if called multiple times
      this.warmSandbox(org);

      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('Not found', { status: 404 });
  }

  // Warm up the sandbox container and sync from R2
  // Deduplicates calls from React StrictMode double-mount
  private async warmSandbox(org: string) {
    // Already warmed for this org - skip
    if (this.warmedForOrg === org) {
      console.log('[DO] Sandbox already warmed for org:', org);
      return;
    }

    // Warming in progress - wait for it
    if (this.warmingPromise) {
      console.log('[DO] Sandbox warming already in progress, waiting...');
      await this.warmingPromise;
      return;
    }

    // Start warming
    this.warmingPromise = this.doWarmSandbox(org);
    try {
      await this.warmingPromise;
      this.warmedForOrg = org;
    } finally {
      this.warmingPromise = null;
    }
  }

  private async doWarmSandbox(org: string) {
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
    } catch (e) {
      console.error('[DO] doWarmSandbox: sandbox.exec FAILED:', e);
      // Log more details about the error
      if (e instanceof Error) {
        console.error('[DO] doWarmSandbox: error name:', e.name);
        console.error('[DO] doWarmSandbox: error message:', e.message);
        console.error('[DO] doWarmSandbox: error stack:', e.stack);
      }
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
        if (this.chiridionBaseUrl) processEnv.CLOUDFLARE_API_BASE_URL = `${this.chiridionBaseUrl.replace(/\/+$/, '')}/client/v4`;
        if (this.chiridionSessionId) processEnv.CHIRIDION_SESSION_ID = this.chiridionSessionId;

        // Configure Wrangler to use our local Cloudflare API proxy and a per-sandbox deploy token.
        if (this.deployToken) processEnv.CLOUDFLARE_API_TOKEN = this.deployToken;
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

        // Mint a short-lived integration proxy token for the sandbox
        // This allows the agent to make authenticated requests to external APIs
        const proxyToken = await this.mintIntegrationProxyToken(org, null);
        if (proxyToken && this.chiridionBaseUrl) {
          this.currentProxyToken = proxyToken;
          processEnv.CHIRIDION_PROXY_TOKEN = proxyToken;
          processEnv.CHIRIDION_PROXY_BASE_URL = this.chiridionBaseUrl;
          processEnv.CHIRIDION_ORG_ID = org;
          console.log('[DO] Minted integration proxy token for org:', org, 'baseUrl:', this.chiridionBaseUrl);
        } else if (!this.chiridionBaseUrl) {
          console.log('[DO] Skipping proxy token - no chiridionBaseUrl');
        } else {
          console.log('[DO] Failed to mint proxy token');
        }

        const process = await this.sandbox.startProcess('sh /app/run-driver.sh', { env: processEnv });

        this.currentProcessId = process.id;
        // Persist transient state so we can clean up orphaned tokens after hibernation
        this.persistTransientState();
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

                  // Auto-title on first message
                  if (data.autoTitle && data.threadId && data.org) {
                    const title = data.content.slice(0, 30) + (data.content.length > 30 ? '...' : '');
                    const indexId = this.env.CHAT_INDEX.idFromName(data.org);
                    const indexStub = this.env.CHAT_INDEX.get(indexId);
                    indexStub.updateThread(data.threadId, title);
                  }
                  // Expire proxy token and clear state now that process is done
                  await this.expireProxyToken();
                  this.currentProcessId = null;
                  this.clearTransientState();
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
                  // Expire proxy token and clear state now that process is done
                  await this.expireProxyToken();
                  this.currentProcessId = null;
                  this.clearTransientState();
                  return;
                }
              } catch {
                // Skip malformed data
              }
            }
          }
        }

        // Fallback: if we get here without a result event, still complete
        const responseContent = finalContent || '(no response)';
        const assistantMsg = this.addMessage('assistant', responseContent);
        this.broadcast({ type: 'message', message: assistantMsg });
        // Expire proxy token and clear state now that process is done
        await this.expireProxyToken();
        this.currentProcessId = null;
        this.clearTransientState();
      }
    } catch (e) {
      console.error('[DO] WebSocket message error:', e);
      // Log more details about the error
      if (e instanceof Error) {
        console.error('[DO] WebSocket error name:', e.name);
        console.error('[DO] WebSocket error message:', e.message);
        console.error('[DO] WebSocket error stack:', e.stack);
      }
      // Expire proxy token and clear state on error
      await this.expireProxyToken();
      this.currentProcessId = null;
      this.clearTransientState();
      ws.send(JSON.stringify({ type: 'error', error: String(e) }));
    }
  }

  // Stop the currently running process
  private async stopCurrentProcess() {
    if (this.currentProcessId && this.sandbox) {
      try {
        console.log('[DO] Killing process:', this.currentProcessId);
        await this.sandbox.killProcess(this.currentProcessId);
        // Expire proxy token and clear state when process is stopped
        await this.expireProxyToken();
        this.currentProcessId = null;
        this.clearTransientState();
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

  /**
   * Called by the CF API proxy when a wrangler deploy succeeds.
   * Broadcasts a deploy_success event to all connected WebSocket clients.
   */
  notifyDeploySuccess(scriptName: string): void {
    console.log('[DO] Deploy success notification for script:', scriptName);
    this.broadcast({
      type: 'deploy_success',
      scriptName,
      timestamp: Date.now(),
    });
  }
}
