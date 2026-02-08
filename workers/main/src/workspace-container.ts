/**
 * Workspace runtime backed by Sprites.
 * Provides filesystem helpers and exec websocket bridging.
 */
import { getTempR2Credentials } from './r2-credentials';
import { createSignedToken } from './signed-tokens';
import { mapCredentialsToEnvVars } from './integration-env';
import { decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  createOpenRouterKey,
  encryptOpenRouterKey,
  decryptOpenRouterKey,
  getKeyHash,
} from './openrouter-keys';
import { SpritesClient } from '@fly/sprites';
import { EMBEDDED_CLAUDE_RUNNER_SOURCE } from './embedded-claude-runner';
import type { OrgDO } from './auth';
import type { WorkspaceDO } from './workspace';

export interface WorkspaceContainerEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  R2_BUCKET: R2Bucket;
  EMAIL_TO_USER: KVNamespace;
  ANTHROPIC_API_KEY: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  R2_BUCKET_NAME?: string;
  R2_ACCOUNT_ID?: string;
  R2_MOUNT_DIR?: string;
  R2_MOUNT_READONLY?: string;
  R2_API_TOKEN?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  WORKER_BASE_URL?: string;
  OPENROUTER_PROVISIONING_KEY?: string;
  DISABLE_JUICEFS?: string;
  CHIRIDION_TRACE_EVENTS?: string;
  CHIRIDION_DEBUG_STARTUP?: string;
  CHIRIDION_DEBUG_SDK?: string;
  CHIRIDION_DEBUG_FS?: string;
  CHIRIDION_DEBUG_PROXY?: string;
  CHIRIDION_PREQUEUE_FIRST_MESSAGE?: string;
  CHIRIDION_FIRST_MESSAGE_DELAY_MS?: string;
  CLAUDE_CODE_ENABLE_TELEMETRY?: string;
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC?: string;
  CLAUDE_CODE_DISABLE_BACKGROUND_TASKS?: string;

  // Sprites runtime config
  SPRITES_TOKEN?: string;
  SPRITES_API_BASE_URL?: string;
  SPRITES_NAME_PREFIX?: string;
  SPRITES_EAGER_PROVISION_ON_CREATE?: string;
}

interface ControlPlaneHealthResponse {
  status: string;
  version?: string;
  pid?: number;
}

interface ControlPlaneExecResponse {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  killed?: boolean;
  signal?: string | null;
}

interface ControlPlaneExistsResponse {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  modifiedAt?: string;
}

interface ControlPlaneReadResponse {
  success: boolean;
  content?: string;
  size?: number;
  isBinary?: boolean;
  encoding?: string;
  mimeType?: string;
  error?: string;
  code?: string;
}

interface ControlPlaneWriteResponse {
  success: boolean;
  error?: string;
  code?: string;
}

interface ControlPlaneListResponse {
  success?: boolean;
  files: Array<{
    name: string;
    type: 'file' | 'directory';
    size: number;
    modifiedAt: string;
    relativePath: string;
    absolutePath: string;
  }>;
  count: number;
  path: string;
  timestamp?: string;
  error?: string;
}

interface ControlPlaneMkdirResponse {
  success: boolean;
  timestamp?: string;
  error?: string;
  code?: string;
}

interface ControlPlaneMoveResponse {
  success: boolean;
  timestamp?: string;
  error?: string;
  code?: string;
}

interface ControlPlaneDeleteResponse {
  success: boolean;
  timestamp?: string;
  error?: string;
  code?: string;
}

interface SpriteRecord {
  id: string;
  name: string;
  url: string;
  status: string;
}

interface SpriteExecSession {
  id: number;
  command: string;
  is_active: boolean;
  tty: boolean;
}

export interface ExecWebSocketParams {
  cmd?: string[];
  path?: string;
  sessionId?: string;
  tty?: boolean;
  stdin?: boolean;
  cols?: number;
  rows?: number;
  maxRunAfterDisconnect?: string;
  env?: Record<string, string>;
}

export interface ClaudeRunnerEnvOptions {
  threadId: string;
  threadDeployToken?: string | null;
  mcpToken?: string | null;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const runtimeCache = new Map<string, WorkspaceContainer>();
const SPRITE_RUNNER_HOME_DIR = '/opt/chiridion';
const DEFAULT_RUNNER_SCRIPT_PATH = `${SPRITE_RUNNER_HOME_DIR}/claude-runner.mjs`;
const RUNNER_DEP_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const SPRITES_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504]);
const SPRITES_MAX_RETRY_ATTEMPTS = 6;
const SPRITES_MAX_GET_AFTER_CREATE_ATTEMPTS = 12;
const SPRITES_BASE_RETRY_DELAY_MS = 250;
const SPRITES_MAX_RETRY_DELAY_MS = 3000;

function toIsoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createDeployToken(
  secret: string,
  workspaceId: string,
  orgId: string,
  orgSlug: string,
  userId: string
): Promise<string> {
  return createSignedToken(secret, {
    org_id: orgId,
    org_slug: orgSlug,
    user_id: userId,
    scopes: ['deploy'],
    exp: Date.now() + TOKEN_TTL_MS,
    workspace_id: workspaceId,
    name: `deploy-${workspaceId}`,
  });
}

export class WorkspaceContainer {
  private workspaceId: string;
  private orgId: string | null = null;
  private envVars: Record<string, string> | null = null;
  private sprite: SpriteRecord | null = null;
  private spritesClient: SpritesClient | null = null;
  private runnerScriptBootstrapped = false;
  private runnerDependencyBootstrapped = false;
  private runnerBootstrapPromise: Promise<void> | null = null;
  private dataProxyTokenExpiry: number | null = null;
  private integrationEnvCache: Record<string, string> = {};

  constructor(private env: WorkspaceContainerEnv, workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  matchesEnv(env: WorkspaceContainerEnv): boolean {
    return this.env === env;
  }

  get runnerExecCommand(): string[] {
    return ['node', DEFAULT_RUNNER_SCRIPT_PATH];
  }

  private get spritesApiBaseUrl(): string {
    return (this.env.SPRITES_API_BASE_URL || 'https://api.sprites.dev').replace(/\/$/, '');
  }

  private requireSpritesToken(): string {
    const token = this.env.SPRITES_TOKEN;
    if (!token) {
      throw new Error('SPRITES_TOKEN is required for workspace runtime');
    }
    return token;
  }

  private getSpritesClient(): SpritesClient {
    if (!this.spritesClient) {
      this.spritesClient = new SpritesClient(this.requireSpritesToken(), {
        baseURL: this.spritesApiBaseUrl,
      });
    }
    return this.spritesClient;
  }

  private getFsWorkingDir(): string {
    return '/';
  }

  private normalizeFsPath(path: string): string {
    if (!path) return '/';
    return path.startsWith('/') ? path : `/${path}`;
  }

  private joinFsPath(base: string, name: string): string {
    const normalizedBase = this.normalizeFsPath(base);
    if (!name) return normalizedBase;
    if (normalizedBase === '/') return `/${name}`;
    return `${normalizedBase}/${name}`;
  }

  private dirnameFsPath(path: string): string {
    const normalized = this.normalizeFsPath(path);
    if (normalized === '/') return '/';
    const idx = normalized.lastIndexOf('/');
    if (idx <= 0) return '/';
    return normalized.slice(0, idx);
  }

  private basenameFsPath(path: string): string {
    const normalized = this.normalizeFsPath(path);
    if (normalized === '/') return '/';
    const idx = normalized.lastIndexOf('/');
    return idx < 0 ? normalized : normalized.slice(idx + 1);
  }

  private extractStatusCode(err: unknown): number | null {
    const message = String((err as { message?: unknown })?.message || err || '');
    const match = message.match(/status\s+(\d{3})/i);
    return match ? Number(match[1]) : null;
  }

  private computeRetryDelayMs(attempt: number): number {
    const exponential = Math.min(
      SPRITES_MAX_RETRY_DELAY_MS,
      SPRITES_BASE_RETRY_DELAY_MS * Math.pow(2, Math.max(0, attempt - 1))
    );
    const jitter = Math.floor(Math.random() * 120);
    return exponential + jitter;
  }

  private isRetryableSpriteStatus(status: number): boolean {
    return SPRITES_RETRYABLE_STATUS_CODES.has(status);
  }

  private isComputeNotRespondingMessage(value: unknown): boolean {
    const message = String(value || '').toLowerCase();
    return message.includes('compute_not_responding') || message.includes('compute for sprite');
  }

  private isRetryableSpriteError(err: unknown): boolean {
    const status = this.extractStatusCode(err);
    if (status && this.isRetryableSpriteStatus(status)) return true;

    const message = String((err as { message?: unknown })?.message || err || '').toLowerCase();
    return this.isComputeNotRespondingMessage(message)
      || message.includes('timed out')
      || message.includes('timeout')
      || message.includes('network');
  }

  private isSpriteNotFoundError(err: unknown): boolean {
    const message = String((err as { message?: unknown })?.message || err || '').toLowerCase();
    return message.includes('sprite not found') || this.extractStatusCode(err) === 404;
  }

  private isSpriteAlreadyExistsError(err: unknown): boolean {
    const message = String((err as { message?: unknown })?.message || err || '').toLowerCase();
    return message.includes('already exists') || this.extractStatusCode(err) === 409;
  }

  private isLocalOnlyWorkerBaseUrl(baseUrl: string): boolean {
    try {
      const url = new URL(baseUrl);
      const host = url.hostname.toLowerCase();
      return host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host === 'host.docker.internal';
    } catch {
      return false;
    }
  }

  private async getSpriteWithRetry(
    client: SpritesClient,
    name: string,
    options: { allowNotFound: boolean; attempts: number }
  ): Promise<{
    id?: string;
    name: string;
    url?: string;
    status?: string;
  } | null> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
      try {
        const sprite = await client.getSprite(name);
        return {
          id: sprite.id,
          name: sprite.name,
          url: (sprite as { url?: string }).url,
          status: sprite.status,
        };
      } catch (err) {
        lastError = err;

        if (this.isSpriteNotFoundError(err)) {
          if (options.allowNotFound) return null;
          if (attempt < options.attempts) {
            await delay(this.computeRetryDelayMs(attempt));
            continue;
          }
          throw err;
        }

        if (this.isRetryableSpriteError(err) && attempt < options.attempts) {
          await delay(this.computeRetryDelayMs(attempt));
          continue;
        }

        throw err;
      }
    }

    if (lastError) throw lastError;
    throw new Error(`Failed to get sprite ${name}`);
  }

  private async createSpriteWithRetry(client: SpritesClient, name: string): Promise<void> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= SPRITES_MAX_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await client.createSprite(name);
        return;
      } catch (err) {
        lastError = err;
        if (this.isSpriteAlreadyExistsError(err)) {
          return;
        }
        if (this.isRetryableSpriteError(err) && attempt < SPRITES_MAX_RETRY_ATTEMPTS) {
          await delay(this.computeRetryDelayMs(attempt));
          continue;
        }
        throw err;
      }
    }

    if (lastError) throw lastError;
  }

  private toSpriteRecord(sprite: { id?: string; name: string; url?: string; status?: string }): SpriteRecord {
    return {
      id: sprite.id || '',
      name: sprite.name,
      url: sprite.url || '',
      status: sprite.status || 'unknown',
    };
  }

  private async createAndFetchSpriteRecord(name: string): Promise<SpriteRecord> {
    const client = this.getSpritesClient();
    await this.createSpriteWithRetry(client, name);

    const created = await this.getSpriteWithRetry(client, name, {
      allowNotFound: false,
      attempts: SPRITES_MAX_GET_AFTER_CREATE_ATTEMPTS,
    });
    if (!created) {
      throw new Error(`Sprite not found after creation: ${name}`);
    }

    return this.toSpriteRecord(created);
  }

  private async fetchSpriteFs(
    spriteName: string,
    endpoint: string,
    init: RequestInit = {},
    query: Record<string, string | number | boolean | undefined> = {}
  ): Promise<Response> {
    const url = new URL(`${this.spritesApiBaseUrl}/v1/sprites/${encodeURIComponent(spriteName)}/fs/${endpoint}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null) continue;
      url.searchParams.set(key, String(value));
    }
    const requestInit: RequestInit = {
      ...init,
      headers: this.buildSpritesHeaders(init.headers),
    };

    let lastResponse: Response | null = null;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= SPRITES_MAX_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url.toString(), requestInit);
        lastResponse = response;

        if (this.isRetryableSpriteStatus(response.status) && attempt < SPRITES_MAX_RETRY_ATTEMPTS) {
          await delay(this.computeRetryDelayMs(attempt));
          continue;
        }

        return response;
      } catch (err) {
        lastError = err;
        if (this.isRetryableSpriteError(err) && attempt < SPRITES_MAX_RETRY_ATTEMPTS) {
          await delay(this.computeRetryDelayMs(attempt));
          continue;
        }
        throw err;
      }
    }

    if (lastResponse) return lastResponse;
    throw lastError instanceof Error ? lastError : new Error(`Failed sprite fs request: ${endpoint}`);
  }

  private parseFsListEntries(payload: unknown): Array<{
    name: string;
    type: 'file' | 'directory';
    size: number;
    modifiedAt: string;
  }> {
    const rawEntries = Array.isArray(payload)
      ? payload
      : Array.isArray((payload as { files?: unknown[] })?.files)
        ? (payload as { files: unknown[] }).files
        : Array.isArray((payload as { entries?: unknown[] })?.entries)
          ? (payload as { entries: unknown[] }).entries
          : Array.isArray((payload as { items?: unknown[] })?.items)
            ? (payload as { items: unknown[] }).items
            : [];

    const nowIso = toIsoTime(Date.now());

    return rawEntries.flatMap((entry) => {
      const raw = (entry ?? {}) as Record<string, unknown>;
      const name = typeof raw.name === 'string'
        ? raw.name
        : typeof raw.path === 'string'
          ? this.basenameFsPath(raw.path)
          : '';
      if (!name || name === '/') return [];

      const rawType = typeof raw.type === 'string' ? raw.type.toLowerCase() : '';
      const isDir = rawType === 'directory' || rawType === 'dir' || raw.isDir === true || raw.isDirectory === true;
      const type: 'file' | 'directory' = isDir ? 'directory' : 'file';
      const size = typeof raw.size === 'number' ? raw.size : 0;
      const modifiedAt = typeof raw.modifiedAt === 'string'
        ? raw.modifiedAt
        : typeof raw.mtime === 'string'
          ? raw.mtime
          : typeof raw.updatedAt === 'string'
            ? raw.updatedAt
            : nowIso;

      return [{ name, type, size, modifiedAt }];
    });
  }

  private async spriteFileExists(spriteName: string, path: string): Promise<boolean> {
    const response = await this.fetchSpriteFs(
      spriteName,
      'read',
      { method: 'GET' },
      {
        path: this.normalizeFsPath(path),
        workingDir: this.getFsWorkingDir(),
      }
    );

    if (response.status === 404) return false;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed checking sprite file ${path}: ${response.status} ${body}`);
    }
    return true;
  }

  private async ensureRunnerScript(spriteName: string): Promise<void> {
    if (this.runnerScriptBootstrapped) return;

    const path = DEFAULT_RUNNER_SCRIPT_PATH;
    const response = await this.fetchSpriteFs(
      spriteName,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/javascript; charset=utf-8' },
        body: EMBEDDED_CLAUDE_RUNNER_SOURCE,
      },
      {
        path,
        workingDir: this.getFsWorkingDir(),
        mode: '0755',
        mkdir: true,
      }
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to bootstrap claude runner script at ${path}: ${response.status} ${body}`);
    }

    this.runnerScriptBootstrapped = true;
  }

  private async ensureRunnerDependencies(spriteName: string): Promise<void> {
    if (this.runnerDependencyBootstrapped) return;

    const installPrefix = SPRITE_RUNNER_HOME_DIR;
    const dependencyPackageJsonPath = `${installPrefix}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`;
    const dependencyExists = await this.spriteFileExists(spriteName, dependencyPackageJsonPath);
    if (dependencyExists) {
      this.runnerDependencyBootstrapped = true;
      return;
    }

    const packageJsonWrite = await this.fetchSpriteFs(
      spriteName,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          name: 'chiridion-sprite-runner',
          private: true,
          type: 'module',
        }, null, 2),
      },
      {
        path: `${installPrefix}/package.json`,
        workingDir: this.getFsWorkingDir(),
        mkdir: true,
      }
    );
    if (!packageJsonWrite.ok) {
      const body = await packageJsonWrite.text();
      throw new Error(`Failed writing /app/package.json: ${packageJsonWrite.status} ${body}`);
    }

    const installResult = await this.execHttpRawForSprite(
      spriteName,
      [
        'bash',
        '-lc',
        `npm install --prefix ${installPrefix} --silent --no-progress --no-audit --no-fund ${RUNNER_DEP_PACKAGE}`,
      ]
    );

    if (!installResult.success) {
      throw new Error(
        `Failed to install ${RUNNER_DEP_PACKAGE}: ${installResult.stderr || installResult.stdout || 'unknown error'}`
      );
    }

    const installed = await this.spriteFileExists(spriteName, dependencyPackageJsonPath);
    if (!installed) {
      const installOutput = `${installResult.stderr || ''}\n${installResult.stdout || ''}`.trim().slice(0, 2000);
      throw new Error(
        `Dependency install completed but ${RUNNER_DEP_PACKAGE} was not found in ${dependencyPackageJsonPath}. ` +
        `Install output: ${installOutput || '<empty>'}`
      );
    }

    this.runnerDependencyBootstrapped = true;
  }

  private async ensureRunnerBootstrap(spriteName: string): Promise<void> {
    if (this.runnerScriptBootstrapped && this.runnerDependencyBootstrapped) {
      return;
    }

    if (this.runnerBootstrapPromise) {
      await this.runnerBootstrapPromise;
      return;
    }

    this.runnerBootstrapPromise = (async () => {
      await this.ensureRunnerScript(spriteName);
      await this.ensureRunnerDependencies(spriteName);
    })();

    try {
      await this.runnerBootstrapPromise;
    } finally {
      this.runnerBootstrapPromise = null;
    }
  }

  private getSpriteName(workspaceId = this.workspaceId): string {
    const prefix = (this.env.SPRITES_NAME_PREFIX || 'chiridion').trim().toLowerCase();
    const raw = `${prefix}-${getContainerIdForWorkspace(workspaceId)}`;
    const normalized = raw
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
    return (normalized || `chiridion-${Date.now()}`).slice(0, 63);
  }

  private buildSpritesHeaders(extra: HeadersInit = {}): Headers {
    const headers = new Headers(extra);
    headers.set('Authorization', `Bearer ${this.requireSpritesToken()}`);
    return headers;
  }

  private async fetchSprite(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.spritesApiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const headers = this.buildSpritesHeaders(init.headers);
    return fetch(url, { ...init, headers });
  }

  async provisionSpriteForWorkspace(workspaceId = this.workspaceId): Promise<SpriteRecord> {
    this.workspaceId = workspaceId;
    const sprite = await this.createAndFetchSpriteRecord(this.getSpriteName(workspaceId));
    this.sprite = sprite;
    return sprite;
  }

  private async ensureSprite(): Promise<SpriteRecord> {
    let sprite = this.sprite;

    if (!sprite) {
      const name = this.getSpriteName(this.workspaceId);
      const existing = await this.getSpriteWithRetry(this.getSpritesClient(), name, {
        allowNotFound: true,
        attempts: SPRITES_MAX_RETRY_ATTEMPTS,
      });

      if (existing) {
        sprite = this.toSpriteRecord(existing);
      } else {
        // Eager provisioning should create this ahead of first use; this is drift repair.
        sprite = await this.createAndFetchSpriteRecord(name);
      }
    }

    await this.ensureRunnerBootstrap(sprite.name);
    this.sprite = sprite;
    return sprite;
  }

  async buildEnvVars(workspaceId: string, orgId: string): Promise<Record<string, string>> {
    this.workspaceId = workspaceId;
    this.orgId = orgId;

    const envVars: Record<string, string> = {
      ORG_ID: orgId,
      WORKSPACE_ID: workspaceId,
    };

    if (this.env.R2_BUCKET_NAME) envVars.R2_BUCKET_NAME = this.env.R2_BUCKET_NAME;
    if (this.env.R2_ACCOUNT_ID) envVars.R2_ACCOUNT_ID = this.env.R2_ACCOUNT_ID;
    if (this.env.R2_MOUNT_DIR) envVars.R2_MOUNT_DIR = this.env.R2_MOUNT_DIR;
    if (this.env.R2_MOUNT_READONLY) envVars.R2_MOUNT_READONLY = this.env.R2_MOUNT_READONLY;
    if (this.env.DISABLE_JUICEFS) envVars.DISABLE_JUICEFS = this.env.DISABLE_JUICEFS;
    if (this.env.CHIRIDION_TRACE_EVENTS) envVars.CHIRIDION_TRACE_EVENTS = this.env.CHIRIDION_TRACE_EVENTS;
    if (this.env.CHIRIDION_DEBUG_STARTUP) envVars.CHIRIDION_DEBUG_STARTUP = this.env.CHIRIDION_DEBUG_STARTUP;
    if (this.env.CHIRIDION_DEBUG_SDK) envVars.CHIRIDION_DEBUG_SDK = this.env.CHIRIDION_DEBUG_SDK;
    if (this.env.CHIRIDION_DEBUG_FS) envVars.CHIRIDION_DEBUG_FS = this.env.CHIRIDION_DEBUG_FS;
    if (this.env.CHIRIDION_DEBUG_PROXY) envVars.CHIRIDION_DEBUG_PROXY = this.env.CHIRIDION_DEBUG_PROXY;
    if (this.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE) envVars.CHIRIDION_PREQUEUE_FIRST_MESSAGE = this.env.CHIRIDION_PREQUEUE_FIRST_MESSAGE;
    if (this.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS) envVars.CHIRIDION_FIRST_MESSAGE_DELAY_MS = this.env.CHIRIDION_FIRST_MESSAGE_DELAY_MS;
    if (this.env.CLAUDE_CODE_ENABLE_TELEMETRY) envVars.CLAUDE_CODE_ENABLE_TELEMETRY = this.env.CLAUDE_CODE_ENABLE_TELEMETRY;
    if (this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) envVars.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = this.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC;
    if (this.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS) envVars.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = this.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS;

    const prefix = workspaceId === orgId ? `${orgId}/` : `${orgId}/${workspaceId}/`;
    envVars.R2_PREFIX = prefix;

    if (this.env.R2_API_TOKEN && this.env.R2_PARENT_ACCESS_KEY_ID && this.env.R2_ACCOUNT_ID && this.env.R2_BUCKET_NAME) {
      try {
        const sanitizeName = (s: string) => s.replace(/[^a-zA-Z0-9-]/g, '-').replace(/-+/g, '-').slice(0, 20) || 'x';
        const orgSafe = sanitizeName(orgId);
        const wsSafe = sanitizeName(workspaceId);
        const juicefsVolumeName = `chiridion-${orgSafe}-${wsSafe}`;

        const tempCreds = await getTempR2Credentials(
          this.env.R2_ACCOUNT_ID,
          this.env.R2_BUCKET_NAME,
          this.env.R2_PARENT_ACCESS_KEY_ID,
          this.env.R2_API_TOKEN,
          [prefix, `${juicefsVolumeName}/`],
          86400
        );
        envVars.AWS_ACCESS_KEY_ID = tempCreds.accessKeyId;
        envVars.AWS_SECRET_ACCESS_KEY = tempCreds.secretAccessKey;
        envVars.AWS_SESSION_TOKEN = tempCreds.sessionToken;

        const placeholderKey = `${prefix}.keep`;
        const existing = await this.env.R2_BUCKET.head(placeholderKey);
        if (!existing) {
          await this.env.R2_BUCKET.put(placeholderKey, '');
        }
      } catch (e) {
        console.error('[WorkspaceContainer] Failed to get R2 credentials:', e);
      }
    }

    envVars.CLOUDFLARE_ACCOUNT_ID = 'chiridion';
    if (this.env.CF_DISPATCH_NAMESPACE) envVars.CF_DISPATCH_NAMESPACE = this.env.CF_DISPATCH_NAMESPACE;
    envVars.WRANGLER_SEND_METRICS = 'false';
    envVars.CI = '1';

    if (!this.env.TOKEN_SIGNING_SECRET) {
      throw new Error('TOKEN_SIGNING_SECRET is required for token signing');
    }

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(orgId));
    const orgInfo = await orgStub.getInfo();
    const userId = orgInfo?.created_by || 'system';
    const orgName = orgInfo?.name || orgId;
    const orgSlug = orgInfo?.slug || `org-${orgId.slice(0, 3)}`;

    if (!this.env.WORKER_BASE_URL) {
      throw new Error('WORKER_BASE_URL is required for Claude API proxy');
    }

    const workerBaseUrl = this.env.WORKER_BASE_URL;
    const useDirectAnthropic = this.isLocalOnlyWorkerBaseUrl(workerBaseUrl);

    if (useDirectAnthropic) {
      // Local worker URLs are not reachable from sprites. In local dev, route Claude SDK
      // directly to Anthropic so chat remains usable.
      envVars.ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
      envVars.ANTHROPIC_API_KEY = this.env.ANTHROPIC_API_KEY;
      console.warn(
        '[WorkspaceContainer] WORKER_BASE_URL is local-only; using direct Anthropic API for sprite runtime',
        { workerBaseUrl }
      );
    } else {
      const claudeApiToken = await createSignedToken(this.env.TOKEN_SIGNING_SECRET, {
        org_id: orgId,
        org_slug: orgSlug,
        user_id: userId,
        scopes: ['claude_api'],
        exp: Date.now() + TOKEN_TTL_MS,
        workspace_id: workspaceId,
        name: `claude-api-${workspaceId}`,
      });
      envVars.ANTHROPIC_BASE_URL = `${workerBaseUrl}/api/claude`;
      envVars.ANTHROPIC_API_KEY = claudeApiToken;
    }

    const keyRecord = await orgStub.getOpenRouterKeyRecord();
    if (keyRecord) {
      try {
        const openRouterKey = await decryptOpenRouterKey(keyRecord.key_encrypted, this.env.INTEGRATION_SECRET_KEY);
        envVars.OPENROUTER_API_KEY = openRouterKey;
      } catch (e) {
        console.error('[WorkspaceContainer] Failed to decrypt org OpenRouter key:', e);
      }
    } else if (this.env.OPENROUTER_PROVISIONING_KEY) {
      try {
        const keyResponse = await createOpenRouterKey(this.env.OPENROUTER_PROVISIONING_KEY, {
          name: `Chiridion - ${orgName}`,
        });

        const keyHash = getKeyHash(keyResponse.key);
        const keyEncrypted = await encryptOpenRouterKey(keyResponse.key, this.env.INTEGRATION_SECRET_KEY);
        await orgStub.setOpenRouterKey(
          keyHash,
          keyEncrypted,
          `Chiridion - ${orgName}`,
          keyResponse.data.hash,
          null
        );
        envVars.OPENROUTER_API_KEY = keyResponse.key;
      } catch (e) {
        console.error('[WorkspaceContainer] Failed to create org OpenRouter key:', e);
      }
    }

    envVars.WORKER_BASE_URL = workerBaseUrl;
    envVars.CLOUDFLARE_API_BASE_URL = `${workerBaseUrl}/client/v4`;

    const deployToken = await createDeployToken(this.env.TOKEN_SIGNING_SECRET, workspaceId, orgId, orgSlug, userId);
    envVars.CLOUDFLARE_API_TOKEN = deployToken;

    const dataProxyTokenExpiry = Date.now() + TOKEN_TTL_MS;
    const dataProxyToken = await createSignedToken(this.env.TOKEN_SIGNING_SECRET, {
      org_id: orgId,
      org_slug: orgSlug,
      user_id: userId,
      scopes: ['data-proxy'],
      exp: dataProxyTokenExpiry,
      workspace_id: workspaceId,
      name: `data-proxy-${workspaceId}`,
    });
    envVars.DATA_PROXY_TOKEN = dataProxyToken;
    envVars.DATA_PROXY_URL = `${workerBaseUrl}/api`;
    this.dataProxyTokenExpiry = dataProxyTokenExpiry;

    if (!useDirectAnthropic) {
      envVars.MCP_SERVER_URL = `${workerBaseUrl}/mcp`;
    }

    return envVars;
  }

  async startForWorkspace(workspaceId: string, orgId: string): Promise<void> {
    this.workspaceId = workspaceId;
    this.orgId = orgId;

    if (!this.envVars || Object.keys(this.envVars).length === 0) {
      this.envVars = await this.buildEnvVars(workspaceId, orgId);
    }

    await this.ensureSprite();

    if (this.dataProxyTokenExpiry) {
      try {
        const workspaceStub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
        await workspaceStub.registerDataProxyTokenExpiry(this.dataProxyTokenExpiry);
      } catch (err) {
        console.error('[WorkspaceContainer] Failed to register data proxy token expiry:', err);
      }
    }
  }

  async buildClaudeRunnerEnv(options: ClaudeRunnerEnvOptions): Promise<Record<string, string>> {
    if (!this.workspaceId || !this.orgId) {
      throw new Error('WorkspaceContainer not initialized. Call startForWorkspace first.');
    }

    const baseEnv = this.envVars || (await this.buildEnvVars(this.workspaceId, this.orgId));
    const integrationEnv = await this.fetchIntegrationEnvVars(this.workspaceId);
    this.integrationEnvCache = { ...integrationEnv };

    const env: Record<string, string> = {
      ...baseEnv,
      ...integrationEnv,
      CHIRIDION_THREAD_ID: options.threadId,
    };

    if (options.threadDeployToken) env.CHIRIDION_THREAD_DEPLOY_TOKEN = options.threadDeployToken;
    if (options.mcpToken) env.CHIRIDION_MCP_TOKEN = options.mcpToken;

    return env;
  }

  async connectExecWebSocket(params: ExecWebSocketParams): Promise<WebSocket> {
    const sprite = await this.ensureSprite();
    return this.connectExecWebSocketForSprite(sprite.name, params);
  }

  private async connectExecWebSocketForSprite(spriteName: string, params: ExecWebSocketParams): Promise<WebSocket> {
    const hasCmd = Array.isArray(params.cmd) && params.cmd.length > 0;
    const hasSessionId = typeof params.sessionId === 'string' && params.sessionId.length > 0;

    if (!hasCmd && !hasSessionId) {
      throw new Error('connectExecWebSocket requires cmd[] or sessionId');
    }

    const base = hasSessionId && !hasCmd
      ? `${this.spritesApiBaseUrl}/v1/sprites/${encodeURIComponent(spriteName)}/exec/${encodeURIComponent(params.sessionId!)}`
      : `${this.spritesApiBaseUrl}/v1/sprites/${encodeURIComponent(spriteName)}/exec`;
    const url = new URL(base);

    if (hasCmd) {
      for (const arg of params.cmd!) {
        url.searchParams.append('cmd', arg);
      }
      url.searchParams.set('path', params.path || params.cmd![0]);
    }
    if (hasSessionId && hasCmd) url.searchParams.set('id', params.sessionId!);
    if (params.tty) url.searchParams.set('tty', 'true');
    if (params.stdin !== false) url.searchParams.set('stdin', 'true');
    if (typeof params.cols === 'number') url.searchParams.set('cols', `${params.cols}`);
    if (typeof params.rows === 'number') url.searchParams.set('rows', `${params.rows}`);
    if (params.maxRunAfterDisconnect) {
      url.searchParams.set('max_run_after_disconnect', params.maxRunAfterDisconnect);
    }

    if (params.env) {
      for (const [key, value] of Object.entries(params.env)) {
        url.searchParams.append('env', `${key}=${value}`);
      }
    }

    const response = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${this.requireSpritesToken()}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      },
    });

    if (response.status !== 101 || !response.webSocket) {
      const body = await response.text();
      throw new Error(`Failed to open exec websocket: ${response.status} ${body}`);
    }

    const ws = response.webSocket;
    ws.accept();
    return ws;
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response('Chat websocket proxy moved to ChatThreadDO sprite exec bridge', { status: 410 });
  }

  async healthCheck(): Promise<ControlPlaneHealthResponse> {
    const sprite = await this.ensureSprite();
    return { status: sprite.status || 'unknown' };
  }

  private async execHttpRawForSprite(
    spriteName: string,
    args: string[],
    options: {
      cwd?: string;
      stdin?: string;
      env?: Record<string, string>;
    } = {}
  ): Promise<ControlPlaneExecResponse> {
    const url = new URL(`${this.spritesApiBaseUrl}/v1/sprites/${encodeURIComponent(spriteName)}/exec`);

    for (const arg of args) {
      url.searchParams.append('cmd', arg);
    }

    if (options.cwd) {
      url.searchParams.set('dir', options.cwd);
    }

    if (typeof options.stdin === 'string') {
      url.searchParams.set('stdin', 'true');
    }

    if (options.env && Object.keys(options.env).length > 0) {
      for (const [key, value] of Object.entries(options.env)) {
        url.searchParams.append('env', `${key}=${value}`);
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: this.buildSpritesHeaders(),
      body: options.stdin,
    });

    const body = await response.text();

    if (!response.ok) {
      return {
        success: false,
        stdout: '',
        stderr: body,
        exitCode: response.status,
      };
    }

    return {
      success: true,
      stdout: body,
      stderr: '',
      exitCode: 0,
    };
  }

  private async execHttpRaw(
    args: string[],
    options: {
      cwd?: string;
      stdin?: string;
      env?: Record<string, string>;
    } = {}
  ): Promise<ControlPlaneExecResponse> {
    const sprite = await this.ensureSprite();
    return this.execHttpRawForSprite(sprite.name, args, options);
  }

  async exec(command: string, options?: { timeout?: number; cwd?: string }): Promise<ControlPlaneExecResponse> {
    const _timeout = options?.timeout;
    return this.execHttpRaw(['bash', '-lc', command], { cwd: options?.cwd });
  }

  async exists(path: string): Promise<ControlPlaneExistsResponse> {
    const normalizedPath = this.normalizeFsPath(path);
    if (normalizedPath === '/') {
      return { exists: true, isDirectory: true, isFile: false, size: 0, modifiedAt: toIsoTime(Date.now()) };
    }

    const dir = this.dirnameFsPath(normalizedPath);
    const base = this.basenameFsPath(normalizedPath);
    const listResult = await this.listFiles(dir, { recursive: false, includeHidden: true });
    const match = listResult.files.find((entry) => entry.name === base);
    if (!match) {
      return { exists: false };
    }

    return {
      exists: true,
      isFile: match.type === 'file',
      isDirectory: match.type === 'directory',
      size: match.size,
      modifiedAt: match.modifiedAt,
    };
  }

  async readFile(path: string): Promise<ControlPlaneReadResponse> {
    const sprite = await this.ensureSprite();
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSpriteFs(
      sprite.name,
      'read',
      { method: 'GET' },
      { path: normalizedPath, workingDir: this.getFsWorkingDir() }
    );

    if (response.status === 404) {
      return { success: false, error: 'File not found', code: 'ENOENT' };
    }

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Read failed', code: `HTTP_${response.status}` };
    }

    const buffer = new Uint8Array(await response.arrayBuffer());
    const hasNul = buffer.includes(0);
    const content = hasNul
      ? Buffer.from(buffer).toString('base64')
      : new TextDecoder().decode(buffer);

    return {
      success: true,
      content,
      size: buffer.byteLength,
      isBinary: hasNul,
      encoding: hasNul ? 'base64' : 'utf8',
    };
  }

  async writeFile(path: string, content: string): Promise<ControlPlaneWriteResponse> {
    const sprite = await this.ensureSprite();
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSpriteFs(
      sprite.name,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: content,
      },
      {
        path: normalizedPath,
        workingDir: this.getFsWorkingDir(),
        mkdir: true,
      }
    );

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Write failed', code: `HTTP_${response.status}` };
    }

    return { success: true };
  }

  async writeBinaryFile(path: string, base64Content: string): Promise<ControlPlaneWriteResponse> {
    const sprite = await this.ensureSprite();
    const normalizedPath = this.normalizeFsPath(path);
    const binaryBuffer = Buffer.from(base64Content, 'base64');
    const response = await this.fetchSpriteFs(
      sprite.name,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: binaryBuffer,
      },
      {
        path: normalizedPath,
        workingDir: this.getFsWorkingDir(),
        mkdir: true,
      }
    );

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Write failed', code: `HTTP_${response.status}` };
    }

    return { success: true };
  }

  async listFiles(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<ControlPlaneListResponse> {
    const sprite = await this.ensureSprite();
    const root = this.normalizeFsPath(path);
    const recursive = options?.recursive === true;
    const includeHidden = options?.includeHidden === true;
    const files: ControlPlaneListResponse['files'] = [];

    const walk = async (current: string): Promise<void> => {
      const response = await this.fetchSpriteFs(
        sprite.name,
        'list',
        { method: 'GET' },
        { path: current, workingDir: this.getFsWorkingDir() }
      );

      if (response.status === 404) {
        throw new Error(`Path not found: ${current}`);
      }

      if (!response.ok) {
        const body = await response.text();
        throw new Error(body || `Failed to list directory: ${response.status}`);
      }

      const payload = await response.json();
      const entries = this.parseFsListEntries(payload);
      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;
        const absolutePath = this.joinFsPath(current, entry.name);
        const relativePath = absolutePath.startsWith(`${root}/`)
          ? absolutePath.slice(root.length + 1)
          : absolutePath === root
            ? entry.name
            : absolutePath;

        files.push({
          name: entry.name,
          type: entry.type,
          size: entry.size,
          modifiedAt: entry.modifiedAt,
          relativePath,
          absolutePath,
        });

        if (recursive && entry.type === 'directory') {
          await walk(absolutePath);
        }
      }
    };

    try {
      await walk(root);
      return {
        success: true,
        files,
        count: files.length,
        path: root,
        timestamp: toIsoTime(Date.now()),
      };
    } catch (err) {
      return {
        success: false,
        files: [],
        count: 0,
        path: root,
        error: String((err as { message?: unknown })?.message || err),
      };
    }
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<ControlPlaneMkdirResponse> {
    const recursive = options?.recursive !== false;
    if (!recursive) {
      return {
        success: false,
        error: 'mkdir with recursive=false is not supported by sprites fs API',
        code: 'ENOTSUP',
      };
    }

    const keepFilePath = this.joinFsPath(this.normalizeFsPath(path), '.chiridion.keep');
    const writeResult = await this.writeFile(keepFilePath, '');
    if (!writeResult.success) {
      return writeResult;
    }
    await this.deleteFile(keepFilePath);
    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async moveFile(source: string, destination: string): Promise<ControlPlaneMoveResponse> {
    const sprite = await this.ensureSprite();
    const response = await this.fetchSpriteFs(sprite.name, 'rename', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source: this.normalizeFsPath(source),
        dest: this.normalizeFsPath(destination),
        workingDir: this.getFsWorkingDir(),
        asRoot: false,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { success: false, error: body || 'Move failed', code: `HTTP_${response.status}` };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async deleteFile(path: string): Promise<ControlPlaneDeleteResponse> {
    const sprite = await this.ensureSprite();
    const response = await this.fetchSpriteFs(sprite.name, 'delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: this.normalizeFsPath(path),
        workingDir: this.getFsWorkingDir(),
        recursive: true,
        asRoot: false,
      }),
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      return { success: false, error: body || 'Delete failed', code: `HTTP_${response.status}` };
    }

    return { success: true, timestamp: toIsoTime(Date.now()) };
  }

  async fetchIntegrationEnvVars(workspaceId: string): Promise<Record<string, string>> {
    const integrationEnvVars: Record<string, string> = {};
    try {
      const workspaceStub = this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(workspaceId));
      const records = await workspaceStub.getIntegrations();

      for (const record of records) {
        const credentials = await decryptCredentials(record.credentials_encrypted, this.env.INTEGRATION_SECRET_KEY);
        const config = JSON.parse(record.config) as Record<string, unknown>;
        Object.assign(integrationEnvVars, mapCredentialsToEnvVars(record.name, record.integration_type, credentials, config));
      }

      const dataProxyResult = await workspaceStub.generateDataProxyToken();
      if (dataProxyResult) {
        integrationEnvVars.DATA_PROXY_TOKEN = dataProxyResult.token;
        this.dataProxyTokenExpiry = dataProxyResult.expiresAt;
      }
    } catch (e) {
      console.error('[WorkspaceContainer] Failed to fetch integration env vars:', e);
    }

    return integrationEnvVars;
  }

  async pushIntegrationEnvVars(envVars: Record<string, string>): Promise<boolean> {
    this.integrationEnvCache = { ...envVars };
    return true;
  }

  async refreshIntegrationEnvVars(workspaceId: string): Promise<boolean> {
    const envVars = await this.fetchIntegrationEnvVars(workspaceId);
    return this.pushIntegrationEnvVars(envVars);
  }

  async destroy(): Promise<void> {
    try {
      const sprite = await this.ensureSprite();
      const sessionsRes = await this.fetchSprite(`/v1/sprites/${encodeURIComponent(sprite.name)}/exec`, {
        method: 'GET',
      });

      if (sessionsRes.ok) {
        const sessions = await sessionsRes.json() as SpriteExecSession[];
        await Promise.all(
          sessions
            .filter((session) => session.is_active)
            .map(async (session) => {
              await this.fetchSprite(`/v1/sprites/${encodeURIComponent(sprite.name)}/exec/${session.id}/kill`, {
                method: 'POST',
              }).catch(() => {});
            })
        );
      }
    } catch (err) {
      console.error('[WorkspaceContainer] destroy() failed:', err);
      throw err;
    }
  }
}

export function getContainerIdForWorkspace(workspaceId: string): string {
  const safeId = workspaceId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return `ws-${safeId}`.slice(0, 63);
}

export function getWorkspaceContainer(
  env: WorkspaceContainerEnv,
  workspaceId: string
): WorkspaceContainer {
  const cacheKey = `${workspaceId}`;
  const cached = runtimeCache.get(cacheKey);
  if (cached && cached.matchesEnv(env)) {
    return cached;
  }

  const runtime = new WorkspaceContainer(env, workspaceId);
  runtimeCache.set(cacheKey, runtime);
  return runtime;
}

export async function handleWebSocketUpgrade(
  _request: Request,
  _env: WorkspaceContainerEnv,
  workspaceId: string,
  _orgId: string
): Promise<Response> {
  return new Response(
    JSON.stringify({
      error: 'Chat websocket proxy moved to ChatThreadDO sprite exec bridge',
      workspaceId,
      at: toIsoTime(Date.now()),
    }),
    {
      status: 410,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}
