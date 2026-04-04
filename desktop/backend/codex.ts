import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import type {
  DesktopAuthState,
  DesktopModel,
  DesktopModelOption,
} from '../shared/protocol';
import type { DesktopProviderDefinition } from './provider-types';

const DEFAULT_CODEX_MODEL: DesktopModel =
  process.env.DESKTOP_CODEX_MODEL?.trim() || 'gpt-5.4';
const HOST_CODEX_HOME = process.env.CODEX_HOME?.trim()
  ? resolve(process.env.CODEX_HOME)
  : resolve(homedir(), '.codex');
const HOST_CODEX_AUTH_PATH = resolve(HOST_CODEX_HOME, 'auth.json');
const RUNTIME_CODEX_CONFIG = `suppress_unstable_features_warning = true
model = "${DEFAULT_CODEX_MODEL}"
`;

type CodexAuthFile = {
  auth_mode?: unknown;
  OPENAI_API_KEY?: unknown;
  tokens?: unknown;
};

function readHostCodexAuthFile(): CodexAuthFile | null {
  if (!existsSync(HOST_CODEX_AUTH_PATH)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(HOST_CODEX_AUTH_PATH, 'utf8')) as CodexAuthFile;
  } catch {
    return null;
  }
}

function hasCodexApiKey(): boolean {
  return Boolean(process.env.OPENAI_API_KEY?.trim());
}

function getCodexAuthMode(authFile = readHostCodexAuthFile()): string | null {
  return typeof authFile?.auth_mode === 'string' ? authFile.auth_mode : null;
}

function hasCodexAccountAuth(authFile = readHostCodexAuthFile()): boolean {
  if (!authFile || typeof authFile !== 'object') {
    return false;
  }

  return Boolean(
    authFile.tokens ||
      getCodexAuthMode(authFile) === 'chatgpt' ||
      getCodexAuthMode(authFile) === 'device_auth',
  );
}

function getAvailableCodexModels(): DesktopModelOption[] {
  return [
    {
      id: 'gpt-5.4',
      label: 'GPT-5.4',
      provider: 'codex',
    },
    {
      id: 'gpt-5.4-mini',
      label: 'GPT-5.4 Mini',
      provider: 'codex',
    },
  ];
}

export function normalizeCodexModel(value: string | null | undefined): DesktopModel {
  const normalized = value?.trim();
  if (!normalized) {
    return DEFAULT_CODEX_MODEL;
  }

  return getAvailableCodexModels().some((option) => option.id === normalized)
    ? normalized
    : DEFAULT_CODEX_MODEL;
}

export function getDefaultCodexModel(): DesktopModel {
  return DEFAULT_CODEX_MODEL;
}

export function getCodexAuthState(): DesktopAuthState {
  const authFile = readHostCodexAuthFile();

  if (hasCodexAccountAuth(authFile)) {
    return {
      provider: 'codex',
      available: true,
      source: 'provider-account',
      label: 'ChatGPT',
    };
  }

  if (hasCodexApiKey() || typeof authFile?.OPENAI_API_KEY === 'string') {
    return {
      provider: 'codex',
      available: true,
      source: 'api-key',
      label: 'OpenAI API key',
    };
  }

  return {
    provider: 'codex',
    available: false,
    source: 'missing',
    label: 'Codex auth missing',
  };
}

function stageCodexRuntimeHome(runtimeHome: string): void {
  const codexHome = resolve(runtimeHome, '.codex');
  mkdirSync(codexHome, { recursive: true });

  if (!existsSync(HOST_CODEX_AUTH_PATH) && !process.env.OPENAI_API_KEY?.trim()) {
    throw new Error(
      'Codex auth was not found on the host. Run `codex login` or set OPENAI_API_KEY before starting the desktop runtime.',
    );
  }

  if (existsSync(HOST_CODEX_AUTH_PATH)) {
    const destinationPath = resolve(codexHome, 'auth.json');
    mkdirSync(dirname(destinationPath), { recursive: true });
    cpSync(HOST_CODEX_AUTH_PATH, destinationPath, { force: true });
  }

  writeFileSync(resolve(codexHome, 'config.toml'), RUNTIME_CODEX_CONFIG, 'utf8');
}

export const codexProvider: DesktopProviderDefinition = {
  id: 'codex',
  label: 'Codex',
  transport: 'runtime-control-plane',
  option: {
    id: 'codex',
    label: 'Codex',
  },
  getDefaultModel: getDefaultCodexModel,
  getAvailableModels: getAvailableCodexModels,
  normalizeModel: normalizeCodexModel,
  getAuthState: getCodexAuthState,
  stageRuntimeHome: stageCodexRuntimeHome,
  buildControlPlaneEnv(model, controlPlanePort) {
    const authFile = readHostCodexAuthFile();
    const lines = [
      "export DESKTOP_PROVIDER='codex'",
      `export DESKTOP_MODEL='${String(model).replace(/'/g, `'\"'\"'`)}'`,
      `export DESKTOP_CODEX_MODEL='${String(model).replace(/'/g, `'\"'\"'`)}'`,
      `export DESKTOP_RUNTIME_CONTROL_PLANE_PORT='${String(controlPlanePort).replace(/'/g, `'\"'\"'`)}'`,
      "export DESKTOP_RUNTIME_SHARED_DIR='/mnt/camelai-shared'",
      "export HOME='/mnt/camelai-shared/runtime/container-home'",
      "export CODEX_HOME='/mnt/camelai-shared/runtime/container-home/.codex'",
      "export SSL_CERT_FILE='/mnt/camelai-shared/runtime/ca-certificates.pem'",
      "export CURL_CA_BUNDLE='/mnt/camelai-shared/runtime/ca-certificates.pem'",
      "export REQUESTS_CA_BUNDLE='/mnt/camelai-shared/runtime/ca-certificates.pem'",
      "export NODE_EXTRA_CA_CERTS='/mnt/camelai-shared/runtime/ca-certificates.pem'",
    ];

    const openAiApiKey = process.env.OPENAI_API_KEY?.trim();
    if (openAiApiKey && !hasCodexAccountAuth(authFile)) {
      lines.push(`export OPENAI_API_KEY='${openAiApiKey.replace(/'/g, `'\"'\"'`)}'`);
    }

    return lines;
  },
  buildTurnEnv(model) {
    return {
      DESKTOP_PROVIDER: 'codex',
      DESKTOP_MODEL: model,
      DESKTOP_CODEX_MODEL: model,
    };
  },
};
