import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { resolve } from 'node:path';
import type { DesktopModel } from '../shared/protocol';

const DEFAULT_MODEL: DesktopModel = normalizeDesktopModel(process.env.DESKTOP_ANTHROPIC_MODEL);
const HOST_CLAUDE_CONFIG_PATH = resolve(homedir(), '.claude.json');
const HOST_CLAUDE_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR?.trim()
  ? resolve(process.env.CLAUDE_CONFIG_DIR)
  : resolve(homedir(), '.claude');
const HOST_CLAUDE_CREDENTIALS_PATH = resolve(HOST_CLAUDE_CONFIG_DIR, '.credentials.json');

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

export function normalizeDesktopModel(value: string | null | undefined): DesktopModel {
  return value === 'opus' ? 'opus' : 'sonnet';
}

export function getDefaultConfiguredModel(): DesktopModel {
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

export function getClaudeAuthState(): {
  hasClaudeAuth: boolean;
  authSource: 'claude-ai' | 'api-key' | 'missing';
} {
  if (hasClaudeOAuthCredentials()) {
    return {
      hasClaudeAuth: true,
      authSource: 'claude-ai',
    };
  }

  if (hasApiKey()) {
    return {
      hasClaudeAuth: true,
      authSource: 'api-key',
    };
  }

  return {
    hasClaudeAuth: false,
    authSource: 'missing',
  };
}
