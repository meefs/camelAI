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
import { waitUntil } from 'cloudflare:workers';
import { SpritesClient } from '@fly/sprites';
import { SPRITE_ASSETS, SPRITE_BOOTSTRAP_VERSION } from './sprite-assets-manifest';
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
const SPRITE_MANAGED_SKILLS_DIR = '/etc/claude-code/.claude/skills';
const SPRITE_MANAGED_SKILLS_VERSION_PATH = `${SPRITE_MANAGED_SKILLS_DIR}/.chiridion-version`;
const SPRITE_MANAGED_SKILLS_PARENT_DIR = '/etc/claude-code/.claude';
const SPRITE_CREATE_WORKER_DIR = '/usr/local/lib/create-worker';
const SPRITE_CREATE_WORKER_VERSION_PATH = `${SPRITE_CREATE_WORKER_DIR}/.chiridion-version`;
const SPRITE_CREATE_WORKER_BIN = '/usr/local/bin/create-worker';
const RUNNER_DEP_PACKAGE = '@anthropic-ai/claude-agent-sdk';
const RUNNER_DEP_VERSION = '0.2.37';

// Composite version — auto-bumps when any bootstrap component changes.
// Stored in workspace DO storage to skip all sprite filesystem checks on cold start.
export const BOOTSTRAP_VERSION = [
  '2',                            // schema version — bump for structural bootstrap changes
  RUNNER_DEP_VERSION,             // SDK pinned version
  SPRITE_BOOTSTRAP_VERSION,       // combined asset hashes from manifest
].join(':');
const SPRITES_RETRYABLE_STATUS_CODES = new Set([408, 425, 429, 500, 502, 503, 504, 524]);
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
  private runnerSkillsBootstrapped = false;
  private createWorkerBootstrapped = false;
  private runnerBootstrapPromise: Promise<void> | null = null;
  private spriteKnownToExist = false;
  private r2MountServiceCreated = false;
  private dataProxyTokenExpiry: number | null = null;
  private integrationEnvCache: Record<string, string> = {};

  constructor(private env: WorkspaceContainerEnv, workspaceId: string) {
    this.workspaceId = workspaceId;
  }

  matchesEnv(env: WorkspaceContainerEnv): boolean {
    return this.env === env;
  }

  get runnerExecCommand(): string[] {
    return ['bun', 'run', DEFAULT_RUNNER_SCRIPT_PATH];
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

  private async createSpriteWithRetry(client: SpritesClient, name: string): Promise<boolean> {
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= SPRITES_MAX_RETRY_ATTEMPTS; attempt += 1) {
      try {
        await client.createSprite(name);
        return true;
      } catch (err) {
        lastError = err;
        if (this.isSpriteAlreadyExistsError(err)) {
          return false;
        }
        if (this.isRetryableSpriteError(err) && attempt < SPRITES_MAX_RETRY_ATTEMPTS) {
          await delay(this.computeRetryDelayMs(attempt));
          continue;
        }
        throw err;
      }
    }

    if (lastError) throw lastError;
    return false;
  }

  private toSpriteRecord(sprite: { id?: string; name: string; url?: string; status?: string }): SpriteRecord {
    return {
      id: sprite.id || '',
      name: sprite.name,
      url: sprite.url || '',
      status: sprite.status || 'unknown',
    };
  }

  private async createAndFetchSpriteRecord(name: string): Promise<{ sprite: SpriteRecord; created: boolean }> {
    const client = this.getSpritesClient();
    const didCreate = await this.createSpriteWithRetry(client, name);

    const spriteDetails = await this.getSpriteWithRetry(client, name, {
      allowNotFound: false,
      attempts: SPRITES_MAX_GET_AFTER_CREATE_ATTEMPTS,
    });
    if (!spriteDetails) {
      throw new Error(`Sprite not found after creation: ${name}`);
    }

    return { sprite: this.toSpriteRecord(spriteDetails), created: didCreate };
  }

  private async clearSpriteUserClaudeDir(spriteName: string): Promise<void> {
    const response = await this.fetchSpriteFs(spriteName, 'delete', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: '/home/sprite/.claude',
        workingDir: this.getFsWorkingDir(),
        recursive: true,
        asRoot: false,
      }),
    });

    if (!response.ok && response.status !== 404) {
      const body = await response.text();
      throw new Error(`Failed clearing /home/sprite/.claude: ${response.status} ${body}`);
    }
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

  private getAssetUrl(assetPath: string): string {
    const baseUrl = this.env.WORKER_BASE_URL;
    if (!baseUrl) {
      throw new Error('WORKER_BASE_URL is required for sprite asset downloads');
    }
    return `${baseUrl.replace(/\/$/, '')}${assetPath}`;
  }

  private async ensureRunnerScripts(spriteName: string): Promise<void> {
    if (this.runnerScriptBootstrapped) return;
    console.log(`[Sprite] bootstrap: downloading runner scripts (${SPRITE_ASSETS.runner.hash})`);

    const assetUrl = this.getAssetUrl(SPRITE_ASSETS.runner.path);
    const installResult = await this.execHttpRawForSprite(
      spriteName,
      [
        'bash',
        '-lc',
        [
          'set -euo pipefail',
          `mkdir -p ${JSON.stringify(SPRITE_RUNNER_HOME_DIR)}`,
          `curl -fsSL ${JSON.stringify(assetUrl)} | tar -xzf - -C ${JSON.stringify(SPRITE_RUNNER_HOME_DIR)}`,
          `chmod +x ${JSON.stringify(DEFAULT_RUNNER_SCRIPT_PATH)}`,
        ].join('; '),
      ]
    );

    if (!installResult.success) {
      throw new Error(
        `Failed to download runner scripts: ${installResult.stderr || installResult.stdout || 'unknown error'}`
      );
    }

    this.runnerScriptBootstrapped = true;
  }

  private async ensureRunnerDependencies(spriteName: string): Promise<void> {
    if (this.runnerDependencyBootstrapped) return;

    const installPrefix = SPRITE_RUNNER_HOME_DIR;
    const dependencyPackageJsonPath = `${installPrefix}/node_modules/@anthropic-ai/claude-agent-sdk/package.json`;

    // Check installed version — skip install if it matches the pinned version.
    const installedPkgJson = await this.readSpriteTextFile(spriteName, dependencyPackageJsonPath);
    if (installedPkgJson) {
      try {
        const { version } = JSON.parse(installedPkgJson) as { version?: string };
        if (version === RUNNER_DEP_VERSION) {
          console.log(`[Sprite] bootstrap: ${RUNNER_DEP_PACKAGE}@${version} already installed`);
          this.runnerDependencyBootstrapped = true;
          return;
        }
        console.log(`[Sprite] bootstrap: upgrading ${RUNNER_DEP_PACKAGE} ${version} → ${RUNNER_DEP_VERSION}`);
      } catch {
        // Corrupt package.json — reinstall.
      }
    } else {
      console.log(`[Sprite] bootstrap: installing ${RUNNER_DEP_PACKAGE}@${RUNNER_DEP_VERSION}`);
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
        `cd ${installPrefix} && bun install --no-progress ${RUNNER_DEP_PACKAGE}@${RUNNER_DEP_VERSION}`,
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

  private async readSpriteTextFile(spriteName: string, path: string): Promise<string | null> {
    const response = await this.fetchSpriteFs(
      spriteName,
      'read',
      { method: 'GET' },
      {
        path: this.normalizeFsPath(path),
        workingDir: this.getFsWorkingDir(),
      }
    );

    if (response.status === 404) return null;
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed reading sprite file ${path}: ${response.status} ${body}`);
    }

    return (await response.text()).trim();
  }

  private async ensureRunnerSkills(spriteName: string): Promise<void> {
    if (this.runnerSkillsBootstrapped) return;

    const installedVersion = await this.readSpriteTextFile(spriteName, SPRITE_MANAGED_SKILLS_VERSION_PATH);
    if (installedVersion === SPRITE_ASSETS.skills.hash) {
      console.log(`[Sprite] bootstrap: skills already at version ${SPRITE_ASSETS.skills.hash}`);
      this.runnerSkillsBootstrapped = true;
      return;
    }
    console.log(`[Sprite] bootstrap: updating skills (${installedVersion || 'none'} → ${SPRITE_ASSETS.skills.hash})`);

    const assetUrl = this.getAssetUrl(SPRITE_ASSETS.skills.path);
    const installResult = await this.execHttpRawForSprite(
      spriteName,
      [
        'bash',
        '-lc',
        [
          'set -euo pipefail',
          `rm -rf ${JSON.stringify(SPRITE_MANAGED_SKILLS_DIR)}`,
          `mkdir -p ${JSON.stringify(SPRITE_MANAGED_SKILLS_PARENT_DIR)}`,
          `curl -fsSL ${JSON.stringify(assetUrl)} | tar -xzf - -C ${JSON.stringify(SPRITE_MANAGED_SKILLS_PARENT_DIR)}`,
        ].join('; '),
      ]
    );
    if (!installResult.success) {
      throw new Error(
        `Failed downloading/extracting skills: ${installResult.stderr || installResult.stdout || 'unknown error'}`
      );
    }

    const versionWrite = await this.fetchSpriteFs(
      spriteName,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: SPRITE_ASSETS.skills.hash,
      },
      {
        path: SPRITE_MANAGED_SKILLS_VERSION_PATH,
        workingDir: this.getFsWorkingDir(),
        mode: '0644',
        mkdir: true,
      }
    );
    if (!versionWrite.ok) {
      const body = await versionWrite.text();
      throw new Error(
        `Failed writing managed skills version marker at ${SPRITE_MANAGED_SKILLS_VERSION_PATH}: ` +
        `${versionWrite.status} ${body}`
      );
    }

    this.runnerSkillsBootstrapped = true;
  }

  private async ensureCreateWorker(spriteName: string): Promise<void> {
    if (this.createWorkerBootstrapped) return;

    const installedVersion = await this.readSpriteTextFile(spriteName, SPRITE_CREATE_WORKER_VERSION_PATH);
    if (installedVersion === SPRITE_ASSETS.createWorker.hash) {
      console.log(`[Sprite] bootstrap: create-worker already at version ${SPRITE_ASSETS.createWorker.hash}`);
      this.createWorkerBootstrapped = true;
      return;
    }
    console.log(`[Sprite] bootstrap: updating create-worker (${installedVersion || 'none'} → ${SPRITE_ASSETS.createWorker.hash})`);

    const assetUrl = this.getAssetUrl(SPRITE_ASSETS.createWorker.path);
    const installResult = await this.execHttpRawForSprite(
      spriteName,
      [
        'bash',
        '-lc',
        [
          'set -euo pipefail',
          `rm -rf ${JSON.stringify(SPRITE_CREATE_WORKER_DIR)}`,
          `mkdir -p /usr/local/lib`,
          `curl -fsSL ${JSON.stringify(assetUrl)} | tar -xzf - -C /usr/local/lib`,
          `chmod +x ${JSON.stringify(`${SPRITE_CREATE_WORKER_DIR}/create-worker.mjs`)}`,
          `ln -sf ${JSON.stringify(`${SPRITE_CREATE_WORKER_DIR}/create-worker.mjs`)} ${JSON.stringify(SPRITE_CREATE_WORKER_BIN)}`,
        ].join('; '),
      ]
    );
    if (!installResult.success) {
      throw new Error(
        `Failed downloading/extracting create-worker: ${installResult.stderr || installResult.stdout || 'unknown error'}`
      );
    }

    const versionWrite = await this.fetchSpriteFs(
      spriteName,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: SPRITE_ASSETS.createWorker.hash,
      },
      {
        path: SPRITE_CREATE_WORKER_VERSION_PATH,
        workingDir: this.getFsWorkingDir(),
        mode: '0644',
        mkdir: true,
      }
    );
    if (!versionWrite.ok) {
      const body = await versionWrite.text();
      throw new Error(
        `Failed writing create-worker version marker at ${SPRITE_CREATE_WORKER_VERSION_PATH}: ` +
        `${versionWrite.status} ${body}`
      );
    }

    this.createWorkerBootstrapped = true;
  }

  /**
   * Mark all bootstrap steps as done if the caller already knows the sprite
   * is at the current BOOTSTRAP_VERSION (e.g. from workspace DO storage).
   */
  setKnownBootstrapVersion(version: string | null | undefined): void {
    if (!version) return;
    // Any persisted version means the sprite was successfully created and bootstrapped at
    // some point. We can skip the Sprites API lookup on cold start.
    this.spriteKnownToExist = true;
    if (version === BOOTSTRAP_VERSION) {
      this.runnerScriptBootstrapped = true;
      this.runnerDependencyBootstrapped = true;
      this.runnerSkillsBootstrapped = true;
      this.createWorkerBootstrapped = true;
    }
  }

  private async ensureRunnerBootstrap(spriteName: string): Promise<void> {
    if (this.runnerScriptBootstrapped && this.runnerDependencyBootstrapped && this.runnerSkillsBootstrapped && this.createWorkerBootstrapped) {
      console.log(`[Sprite] bootstrap: all components up to date (v=${BOOTSTRAP_VERSION.slice(0, 40)})`);
      return;
    }

    if (this.runnerBootstrapPromise) {
      await this.runnerBootstrapPromise;
      return;
    }

    console.log(`[Sprite] bootstrap: running full bootstrap (v=${BOOTSTRAP_VERSION.slice(0, 40)})`);
    this.runnerBootstrapPromise = (async () => {
      await this.ensureRunnerScripts(spriteName);
      await this.ensureRunnerDependencies(spriteName);
      await Promise.all([
        this.ensureRunnerSkills(spriteName),
        this.ensureCreateWorker(spriteName),
      ]);
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

  /**
   * Return the deterministic sprite name for the current workspace.
   * Unlike ensureSprite(), this makes no API calls — it computes the name
   * from the workspaceId alone. Safe for all FS/exec operations since the
   * sprite is guaranteed to exist (provisioned at workspace creation, with
   * bootstrap handled by WorkspaceDO).
   */
  private requireSpriteName(): string {
    return this.getSpriteName(this.workspaceId);
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
    const name = this.getSpriteName(workspaceId);
    console.log(`[Sprite] provisioning sprite=${name} workspace=${workspaceId}`);
    const { sprite, created } = await this.createAndFetchSpriteRecord(name);
    if (created) {
      console.log(`[Sprite] created new sprite=${name}, clearing .claude dir`);
      await this.clearSpriteUserClaudeDir(sprite.name);
    } else {
      console.log(`[Sprite] sprite=${name} already exists (status=${sprite.status})`);
    }
    this.sprite = sprite;
    return sprite;
  }

  private async ensureSprite(): Promise<SpriteRecord> {
    if (this.sprite) return this.sprite;

    const name = this.getSpriteName(this.workspaceId);

    // If a bootstrap version was ever persisted, the sprite must exist —
    // skip the API lookup and construct the record from the deterministic name.
    if (this.spriteKnownToExist) {
      console.log(`[Sprite] ensureSprite: sprite known to exist, skipping API lookup for sprite=${name}`);
      this.sprite = { id: name, name, url: '', status: 'warm' };
      return this.sprite;
    }

    console.log(`[Sprite] ensureSprite: looking up sprite=${name}`);
    const existing = await this.getSpriteWithRetry(this.getSpritesClient(), name, {
      allowNotFound: true,
      attempts: SPRITES_MAX_RETRY_ATTEMPTS,
    });

    let sprite: SpriteRecord;
    if (existing) {
      sprite = this.toSpriteRecord(existing);
      console.log(`[Sprite] ensureSprite: found existing sprite=${name} status=${sprite.status}`);
    } else {
      console.log(`[Sprite] ensureSprite: sprite=${name} not found, creating (drift repair)`);
      const created = await this.createAndFetchSpriteRecord(name);
      sprite = created.sprite;
      if (created.created) {
        await this.clearSpriteUserClaudeDir(sprite.name);
      }
    }

    this.sprite = sprite;
    return sprite;
  }

  /**
   * Ensure the sprite exists and is fully bootstrapped (runner script,
   * dependencies, skills, create-worker). Called by WorkspaceDO.ensureSpriteReady()
   * which owns the persistent bootstrap version tracking.
   */
  async ensureSpriteBootstrapped(workspaceId: string): Promise<void> {
    this.workspaceId = workspaceId;
    const sprite = await this.ensureSprite();
    await this.ensureRunnerBootstrap(sprite.name);
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
        const volumeName = `chiridion-${orgSafe}-${wsSafe}`;

        const tempCreds = await getTempR2Credentials(
          this.env.R2_ACCOUNT_ID,
          this.env.R2_BUCKET_NAME,
          this.env.R2_PARENT_ACCESS_KEY_ID,
          this.env.R2_API_TOKEN,
          [prefix, `${volumeName}/`],
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
    if (this.isLocalOnlyWorkerBaseUrl(workerBaseUrl)) {
      throw new Error(
        `WORKER_BASE_URL must be publicly reachable from sprites (got ${workerBaseUrl}). ` +
        'Use an ngrok URL for local development.'
      );
    }

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

    envVars.MCP_SERVER_URL = `${workerBaseUrl}/mcp`;

    return envVars;
  }

  private async ensureR2MountService(): Promise<void> {
    if (this.r2MountServiceCreated) return;
    if (!this.envVars) return;

    const accessKeyId = this.envVars.AWS_ACCESS_KEY_ID;
    const secretAccessKey = this.envVars.AWS_SECRET_ACCESS_KEY;
    const sessionToken = this.envVars.AWS_SESSION_TOKEN;
    const accountId = this.env.R2_ACCOUNT_ID;
    const bucketName = this.env.R2_BUCKET_NAME;
    // Always use {orgId}/{workspaceId}/ to match the upload API's buildUploadKey(),
    // which always includes both — unlike R2_PREFIX which collapses to {orgId}/ for legacy workspaces.
    const mountPrefix = this.orgId && this.workspaceId
      ? `${this.orgId}/${this.workspaceId}/`
      : null;

    if (!accessKeyId || !secretAccessKey || !sessionToken || !accountId || !bucketName || !mountPrefix) {
      console.log('[Sprite] ensureR2MountService: missing R2 credentials, skipping mount service');
      return;
    }

    const spriteName = this.requireSpriteName();
    console.log(`[Sprite] ensureR2MountService: setting up rclone mounts for sprite=${spriteName}`);

    const r2Endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

    // Always write rclone config so credentials stay current across deploys.
    const rcloneConfig = [
      '[r2]',
      'type = s3',
      'provider = Cloudflare',
      `access_key_id = ${accessKeyId}`,
      `secret_access_key = ${secretAccessKey}`,
      `session_token = ${sessionToken}`,
      `endpoint = ${r2Endpoint}`,
    ].join('\n');

    const rcloneConfigPath = `${SPRITE_RUNNER_HOME_DIR}/rclone.conf`;
    const configWrite = await this.fetchSpriteFs(
      spriteName,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: rcloneConfig,
      },
      {
        path: rcloneConfigPath,
        workingDir: this.getFsWorkingDir(),
        mode: '0600',
        mkdir: true,
      }
    );
    if (!configWrite.ok) {
      const body = await configWrite.text();
      throw new Error(`Failed writing rclone.conf: ${configWrite.status} ${body}`);
    }

    // Write the mount script
    const mountScript = [
      '#!/bin/bash',
      'set -euo pipefail',
      '',
      `RCLONE_CONF="${rcloneConfigPath}"`,
      `BUCKET="${bucketName}"`,
      `PREFIX="${mountPrefix}"`,
      '',
      '# Install rclone + fuse if needed',
      'if ! command -v rclone &>/dev/null; then',
      '  echo "[r2-mount] Installing rclone + fuse..."',
      '  sudo apt-get update -qq && sudo apt-get install -y -qq rclone fuse 2>/dev/null || true',
      'fi',
      '',
      '# Enable user_allow_other for FUSE',
      'grep -q "^user_allow_other" /etc/fuse.conf 2>/dev/null || echo "user_allow_other" | sudo tee -a /etc/fuse.conf > /dev/null',
      '',
      '# Clean up stale mounts from previous runs',
      'sudo fusermount -u /mnt/user-uploads 2>/dev/null || true',
      'sudo fusermount -u /mnt/user-outputs 2>/dev/null || true',
      'sudo pkill -f "rclone mount.*r2:" 2>/dev/null || true',
      'sleep 0.5',
      '',
      'sudo mkdir -p /mnt/user-uploads /mnt/user-outputs',
      '',
      '# Mount user-uploads (read-only) — files owned by sprite user (uid=1001)',
      'sudo rclone mount "r2:${BUCKET}/${PREFIX}user-uploads" /mnt/user-uploads \\',
      '  --config "$RCLONE_CONF" \\',
      '  --allow-other --read-only \\',
      '  --uid 1001 --gid 1001 \\',
      '  --vfs-cache-mode minimal \\',
      '  --dir-cache-time 1s \\',
      '  --daemon 2>&1',
      '',
      '# Mount user-outputs (read-write) — files owned by sprite user (uid=1001)',
      'sudo rclone mount "r2:${BUCKET}/${PREFIX}user-outputs" /mnt/user-outputs \\',
      '  --config "$RCLONE_CONF" \\',
      '  --allow-other \\',
      '  --uid 1001 --gid 1001 \\',
      '  --vfs-cache-mode writes --vfs-write-back 0 \\',
      '  --dir-cache-time 1s \\',
      '  --daemon 2>&1',
      '',
      'sleep 1',
      'echo "[r2-mount] Mounts ready: /mnt/user-uploads (ro), /mnt/user-outputs (rw)"',
    ].join('\n');

    const scriptWrite = await this.fetchSpriteFs(
      spriteName,
      'write',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
        body: mountScript,
      },
      {
        path: `${SPRITE_RUNNER_HOME_DIR}/r2-mount.sh`,
        workingDir: this.getFsWorkingDir(),
        mode: '0755',
        mkdir: true,
      }
    );
    if (!scriptWrite.ok) {
      const body = await scriptWrite.text();
      throw new Error(`Failed writing r2-mount.sh: ${scriptWrite.status} ${body}`);
    }

    // Check if mounts are already active and healthy (ls detects stale FUSE mounts)
    const mountCheck = await this.execHttpRawForSprite(
      spriteName,
      ['bash', '-c', [
        'ls /mnt/user-uploads/ >/dev/null 2>&1 && ls /mnt/user-outputs/ >/dev/null 2>&1 && echo ok',
      ].join('; ')]
    );
    const checkOutput = mountCheck.stdout.trim();
    if (mountCheck.success && checkOutput.endsWith('ok')) {
      console.log(`[Sprite] ensureR2MountService: mounts already active for sprite=${spriteName}, skipping exec (${checkOutput})`);
      this.r2MountServiceCreated = true;
      return;
    }
    console.log(`[Sprite] ensureR2MountService: mounts not active for sprite=${spriteName} (${checkOutput})`);

    // Run the mount script
    console.log(`[Sprite] ensureR2MountService: running mount script for sprite=${spriteName}`);
    const result = await this.execHttpRawForSprite(
      spriteName,
      ['bash', `${SPRITE_RUNNER_HOME_DIR}/r2-mount.sh`]
    );

    if (!result.success) {
      throw new Error(
        `R2 mount script failed: ${result.stderr || result.stdout || 'unknown error'}`
      );
    }

    this.r2MountServiceCreated = true;
    console.log(`[Sprite] ensureR2MountService: rclone mounts ready for sprite=${spriteName}`);
  }

  async startForWorkspace(workspaceId: string, orgId: string): Promise<void> {
    this.workspaceId = workspaceId;
    this.orgId = orgId;

    if (this.envVars && Object.keys(this.envVars).length > 0) return;

    console.log(`[Sprite] startForWorkspace: building env vars workspace=${workspaceId} org=${orgId}`);
    this.envVars = await this.buildEnvVars(workspaceId, orgId);

    // Fire-and-forget: set up R2 FUSE mounts in background
    waitUntil(
      this.ensureR2MountService().catch((err) =>
        console.error('[WorkspaceContainer] R2 mount service setup failed:', err)
      )
    );

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

    console.log(`[Sprite] buildClaudeRunnerEnv: thread=${options.threadId}`);
    const baseEnv = this.envVars || (await this.buildEnvVars(this.workspaceId, this.orgId));
    const integrationEnv = await this.fetchIntegrationEnvVars(this.workspaceId);
    this.integrationEnvCache = { ...integrationEnv };

    const env: Record<string, string> = {
      ...baseEnv,
      ...integrationEnv,
      CHIRIDION_THREAD_ID: options.threadId,
      DEBUG_CLAUDE_AGENT_SDK: '1',
    };

    if (options.threadDeployToken) env.CHIRIDION_THREAD_DEPLOY_TOKEN = options.threadDeployToken;
    if (options.mcpToken) env.CHIRIDION_MCP_TOKEN = options.mcpToken;

    return env;
  }

  async connectExecWebSocket(params: ExecWebSocketParams): Promise<WebSocket> {
    return this.connectExecWebSocketForSprite(this.requireSpriteName(), params);
  }

  private async connectExecWebSocketForSprite(spriteName: string, params: ExecWebSocketParams): Promise<WebSocket> {
    const hasCmd = Array.isArray(params.cmd) && params.cmd.length > 0;
    const hasSessionId = typeof params.sessionId === 'string' && params.sessionId.length > 0;

    if (!hasCmd && !hasSessionId) {
      throw new Error('connectExecWebSocket requires cmd[] or sessionId');
    }

    console.log(`[Sprite] connectExecWebSocket: sprite=${spriteName} cmd=${hasCmd ? params.cmd!.join(' ') : 'none'} sessionId=${params.sessionId || 'none'} envCount=${params.env ? Object.keys(params.env).length : 0}`);

    const url = new URL(`${this.spritesApiBaseUrl}/v1/sprites/${encodeURIComponent(spriteName)}/exec`);

    if (hasCmd) {
      for (const arg of params.cmd!) {
        url.searchParams.append('cmd', arg);
      }
      url.searchParams.set('path', params.path || params.cmd![0]);
    }
    if (hasSessionId) url.searchParams.set('id', params.sessionId!);
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

    const urlString = url.toString();
    console.log(`[Sprite] connectExecWebSocket: URL length=${urlString.length}`);

    const response = await fetch(urlString, {
      headers: {
        Authorization: `Bearer ${this.requireSpritesToken()}`,
        Upgrade: 'websocket',
        Connection: 'Upgrade',
      },
    });

    if (response.status !== 101 || !response.webSocket) {
      const body = await response.text();
      console.error(`[Sprite] connectExecWebSocket: upgrade failed status=${response.status} body=${body.slice(0, 500)}`);
      throw new Error(`Failed to open exec websocket: ${response.status} ${body}`);
    }

    console.log(`[Sprite] connectExecWebSocket: websocket opened for sprite=${spriteName}`);
    return response.webSocket;
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
    return this.execHttpRawForSprite(this.requireSpriteName(), args, options);
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
    const spriteName = this.requireSpriteName();
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSpriteFs(
      spriteName,
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
    const spriteName = this.requireSpriteName();
    const normalizedPath = this.normalizeFsPath(path);
    const response = await this.fetchSpriteFs(
      spriteName,
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
    const spriteName = this.requireSpriteName();
    const normalizedPath = this.normalizeFsPath(path);
    const binaryBuffer = Buffer.from(base64Content, 'base64');
    const response = await this.fetchSpriteFs(
      spriteName,
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
    const spriteName = this.requireSpriteName();
    const root = this.normalizeFsPath(path);
    const recursive = options?.recursive === true;
    const includeHidden = options?.includeHidden === true;
    const files: ControlPlaneListResponse['files'] = [];

    const walk = async (current: string): Promise<void> => {
      const response = await this.fetchSpriteFs(
        spriteName,
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
    const response = await this.fetchSpriteFs(this.requireSpriteName(), 'rename', {
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
    const response = await this.fetchSpriteFs(this.requireSpriteName(), 'delete', {
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
      const spriteName = this.requireSpriteName();
      const sessionsRes = await this.fetchSprite(`/v1/sprites/${encodeURIComponent(spriteName)}/exec`, {
        method: 'GET',
      });

      if (sessionsRes.ok) {
        const sessions = await sessionsRes.json() as SpriteExecSession[];
        await Promise.all(
          sessions
            .filter((session) => session.is_active)
            .map(async (session) => {
              await this.fetchSprite(`/v1/sprites/${encodeURIComponent(spriteName)}/exec/${session.id}/kill`, {
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
