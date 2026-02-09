import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

const RUNNER_PATH = resolve(ROOT_DIR, 'sandbox/claude-runner.mjs');
const MEMORY_LOGGER_PATH = resolve(ROOT_DIR, 'sandbox/memory-logger.mjs');
const OUT_PATH = resolve(ROOT_DIR, 'workers/main/src/embedded-claude-runner.ts');

function toEmbeddedSource(runnerSource, memoryLoggerSource) {
  return `/**\n` +
    ` * Embedded Claude runner source uploaded to sprites via /fs/write.\n` +
    ` * Generated from sandbox/claude-runner.mjs and sandbox/memory-logger.mjs.\n` +
    ` */\n\n` +
    `export const EMBEDDED_CLAUDE_RUNNER_SOURCE = ${JSON.stringify(runnerSource)};\n\n` +
    `export const EMBEDDED_MEMORY_LOGGER_SOURCE = ${JSON.stringify(memoryLoggerSource)};\n`;
}

async function main() {
  const [runnerSource, memoryLoggerSource] = await Promise.all([
    readFile(RUNNER_PATH, 'utf8'),
    readFile(MEMORY_LOGGER_PATH, 'utf8'),
  ]);

  const nextOutput = toEmbeddedSource(runnerSource, memoryLoggerSource);

  let currentOutput = '';
  try {
    currentOutput = await readFile(OUT_PATH, 'utf8');
  } catch {
    // file may not exist yet
  }

  if (currentOutput === nextOutput) {
    console.log('[gen:embedded-runner] up to date');
    return;
  }

  await writeFile(OUT_PATH, nextOutput, 'utf8');
  console.log('[gen:embedded-runner] updated workers/main/src/embedded-claude-runner.ts');
}

main().catch((error) => {
  console.error('[gen:embedded-runner] failed:', error);
  process.exit(1);
});
