import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
} from '../shared/protocol';
import type { DesktopProviderDefinition } from './provider-types';

const CLAUDE_MODELS = ['sonnet', 'opus'] as const satisfies readonly DesktopModel[];
const DEFAULT_MODEL: DesktopModel = normalizeClaudeModel(process.env.DESKTOP_ANTHROPIC_MODEL);
const HOST_CLAUDE_CONFIG_PATH = resolve(homedir(), '.claude.json');
const HOST_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim()
  ? resolve(process.env.CLAUDE_CONFIG_DIR)
  : resolve(homedir(), '.claude');
const HOST_CLAUDE_CREDENTIALS_PATH = resolve(HOST_CLAUDE_CONFIG_DIR, '.credentials.json');
const HOST_CLAUDE_SYNC_PATHS = ['.claude.json'] as const;

function getClaudeKeychainServiceName(suffix = '-credentials'): string {
  const configDirHashSuffix = process.env.CLAUDE_CONFIG_DIR?.trim()
    ? `-${createHash('sha256').update(HOST_CLAUDE_CONFIG_DIR).digest('hex').slice(0, 8)}`
    : '';
  return `Claude Code${suffix}${configDirHashSuffix}`;
}

function getClaudeKeychainAccountName(): string {
  try {
    return process.env.USER || userInfo().username;
  } catch {
    return 'claude-code-user';
  }
}

function normalizeClaudeCredentialsJson(raw: string | null | undefined): string | null {
  if (!raw?.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as {
      claudeAiOauth?: {
        accessToken?: unknown;
      };
    };

    if (
      !parsed.claudeAiOauth ||
      typeof parsed.claudeAiOauth !== 'object' ||
      typeof parsed.claudeAiOauth.accessToken !== 'string' ||
      parsed.claudeAiOauth.accessToken.length === 0
    ) {
      return null;
    }

    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return null;
  }
}

function readDarwinClaudeCredentialsFromKeychain(): string | null {
  if (process.platform !== 'darwin') {
    return null;
  }

  const result = spawnSync(
    'security',
    [
      'find-generic-password',
      '-a',
      getClaudeKeychainAccountName(),
      '-w',
      '-s',
      getClaudeKeychainServiceName(),
    ],
    {
      encoding: 'utf8',
      env: process.env,
      maxBuffer: 1024 * 1024,
    },
  );

  if (result.status !== 0) {
    return null;
  }

  return normalizeClaudeCredentialsJson(result.stdout);
}

export function getHostClaudeCredentialsJson(): string | null {
  if (existsSync(HOST_CLAUDE_CREDENTIALS_PATH)) {
    try {
      return normalizeClaudeCredentialsJson(
        readFileSync(HOST_CLAUDE_CREDENTIALS_PATH, 'utf8'),
      );
    } catch {
      return null;
    }
  }

  return readDarwinClaudeCredentialsFromKeychain();
}

function getAvailableClaudeModels(): DesktopModelOption[] {
  return [
    {
      id: 'sonnet',
      label: 'Claude Sonnet',
      provider: 'claude',
    },
    {
      id: 'opus',
      label: 'Claude Opus',
      provider: 'claude',
    },
  ];
}

export function normalizeClaudeModel(value: string | null | undefined): DesktopModel {
  return value === 'opus' ? 'opus' : 'sonnet';
}

export function getDefaultClaudeModel(): DesktopModel {
  return DEFAULT_MODEL;
}

function hasApiKey(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function hasClaudeOAuthCredentials(): boolean {
  return getHostClaudeCredentialsJson() !== null;
}

export function hasHostClaudeConfig(): boolean {
  return existsSync(HOST_CLAUDE_CONFIG_PATH);
}

export function getClaudeAuthState(): DesktopAuthState {
  if (hasClaudeOAuthCredentials()) {
    return {
      provider: 'claude',
      available: true,
      source: 'provider-account',
      label: 'Claude.ai',
    };
  }

  if (hasApiKey()) {
    return {
      provider: 'claude',
      available: true,
      source: 'api-key',
      label: 'API key',
    };
  }

  return {
    provider: 'claude',
    available: false,
    source: 'missing',
    label: 'Claude auth missing',
  };
}

function getClaudeRuntimeAuthPlan() {
  const hostCredentialsJson = getHostClaudeCredentialsJson();
  const hostPaths = HOST_CLAUDE_SYNC_PATHS.filter((relativePath) =>
    existsSync(resolve(homedir(), relativePath)),
  );

  if (!hostCredentialsJson && !process.env.ANTHROPIC_API_KEY?.trim()) {
    throw new Error(
      'Claude Code auth was not found on the host. Run `claude auth login` or set ANTHROPIC_API_KEY before starting the desktop runtime.',
    );
  }

  return {
    hostPaths: [...hostPaths],
    files: [
      {
        relativePath: '.claude/.credentials.json',
        content: hostCredentialsJson,
      },
    ],
  };
}

function stageClaudeRuntimeHome(runtimeHome: string): void {
  const plan = getClaudeRuntimeAuthPlan();
  mkdirSync(runtimeHome, { recursive: true });

  for (const relativePath of plan.hostPaths) {
    const sourcePath = resolve(homedir(), relativePath);
    const destinationPath = resolve(runtimeHome, relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(sourcePath, destinationPath, { force: true });
  }

  for (const file of plan.files) {
    const destinationPath = resolve(runtimeHome, file.relativePath);
    mkdirSync(dirname(destinationPath), { recursive: true });
    if (file.content === null) {
      rmSync(destinationPath, { force: true });
    } else {
      writeFileSync(destinationPath, file.content, 'utf8');
    }
  }
}

export const claudeProvider: DesktopProviderDefinition = {
  id: 'claude',
  label: 'Claude',
  transport: 'runtime-control-plane',
  option: {
    id: 'claude',
    label: 'Claude',
  },
  getDefaultModel: getDefaultClaudeModel,
  getAvailableModels: getAvailableClaudeModels,
  normalizeModel: normalizeClaudeModel,
  getAuthState: getClaudeAuthState,
  stageRuntimeHome: stageClaudeRuntimeHome,
  buildControlPlaneEnv(model, controlPlanePort) {
    const lines = [
      "export DESKTOP_PROVIDER='claude'",
      `export DESKTOP_MODEL='${String(model).replace(/'/g, `'\"'\"'`)}'`,
      `export DESKTOP_ANTHROPIC_MODEL='${String(model).replace(/'/g, `'\"'\"'`)}'`,
      `export DESKTOP_RUNTIME_CONTROL_PLANE_PORT='${String(controlPlanePort).replace(/'/g, `'\"'\"'`)}'`,
      "export DESKTOP_RUNTIME_SHARED_DIR='/mnt/camelai-shared'",
      "export DESKTOP_CONTROL_PLANE_DEBUG_FILE='/mnt/camelai-shared/logs/claude-sdk-debug.log'",
      "export HOME='/mnt/camelai-shared/runtime/container-home'",
      "export CLAUDE_CONFIG_DIR='/mnt/camelai-shared/runtime/container-home/.claude'",
      "export SSL_CERT_FILE='/mnt/camelai-shared/runtime/ca-certificates.pem'",
      "export CURL_CA_BUNDLE='/mnt/camelai-shared/runtime/ca-certificates.pem'",
      "export REQUESTS_CA_BUNDLE='/mnt/camelai-shared/runtime/ca-certificates.pem'",
      "export NODE_EXTRA_CA_CERTS='/mnt/camelai-shared/runtime/ca-certificates.pem'",
    ];

    const anthropicApiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (anthropicApiKey) {
      lines.push(`export ANTHROPIC_API_KEY='${anthropicApiKey.replace(/'/g, `'\"'\"'`)}'`);
    }

    return lines;
  },
  buildTurnEnv(model) {
    return {
      DESKTOP_PROVIDER: 'claude',
      DESKTOP_MODEL: model,
      DESKTOP_ANTHROPIC_MODEL: model,
    };
  },
};
