import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const backendDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(backendDirectory, '..');
const DEFAULT_DATA_DIR = resolve(desktopDirectory, '.local');
const DEFAULT_LOG_PATH = resolve(process.env.DESKTOP_DATA_DIR || DEFAULT_DATA_DIR, 'logs/desktop-backend.log');
const LEVEL_ORDER = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
} as const;

export type DesktopLogLevel = keyof typeof LEVEL_ORDER;

function normalizeValue(value: unknown, depth = 0): unknown {
  if (depth > 3) {
    return '[max-depth]';
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === 'bigint') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeValue(entry, depth + 1));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, normalizeValue(entry, depth + 1)])
    );
  }

  return value;
}

function normalizeDetails(details: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(details).map(([key, value]) => [key, normalizeValue(value)])
  );
}

function getLogPath(): string {
  return process.env.DESKTOP_BACKEND_LOG_PATH || DEFAULT_LOG_PATH;
}

function parseLevel(value: string | undefined, fallback: DesktopLogLevel): DesktopLogLevel {
  if (!value) return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized in LEVEL_ORDER) {
    return normalized as DesktopLogLevel;
  }
  return fallback;
}

function shouldLog(level: DesktopLogLevel, threshold: DesktopLogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[threshold];
}

function getFileThreshold(): DesktopLogLevel {
  if (process.env.DESKTOP_VERBOSE_LOGS === '1') {
    return 'debug';
  }
  return parseLevel(process.env.DESKTOP_LOG_LEVEL, 'info');
}

function getStderrThreshold(): DesktopLogLevel {
  if (process.env.DESKTOP_STARTUP_PROBE === '1' || process.env.DESKTOP_VERBOSE_LOGS === '1') {
    return 'debug';
  }
  return parseLevel(process.env.DESKTOP_STDERR_LOG_LEVEL, 'warn');
}

export function logDesktop(
  component: string,
  event: string,
  details: Record<string, unknown> = {},
  level: DesktopLogLevel = 'info'
): void {
  const payload = {
    ts: new Date().toISOString(),
    pid: process.pid,
    level,
    component,
    event,
    ...normalizeDetails(details),
  };
  const line = `${JSON.stringify(payload)}\n`;
  const logPath = getLogPath();

  if (shouldLog(level, getFileThreshold())) {
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, line, 'utf8');
    } catch {
      // Logging must not crash the desktop runtime.
    }
  }

  if (shouldLog(level, getStderrThreshold())) {
    try {
      process.stderr.write(line);
    } catch {
      // Ignore stderr write failures.
    }
  }
}

export function getDesktopLogPath(): string {
  return getLogPath();
}
