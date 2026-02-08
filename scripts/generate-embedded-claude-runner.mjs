import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

const RUNNER_PATH = resolve(ROOT_DIR, 'sandbox/claude-runner.mjs');
const OUT_PATH = resolve(ROOT_DIR, 'workers/main/src/embedded-claude-runner.ts');

const IMPORT_LINE = "import { loadUserProfile } from './memory-logger.mjs';\n";
const PROFILE_LOAD_LINE = '      session.userProfile = await loadUserProfile().catch(() => null);\n';

function toEmbeddedSource(source) {
  let embedded = source.replace(IMPORT_LINE, '');
  embedded = embedded.replace(PROFILE_LOAD_LINE, '      session.userProfile = null;\n');

  return `/**\n` +
    ` * Embedded Claude runner source uploaded to sprites via /fs/write.\n` +
    ` * Generated from sandbox/claude-runner.mjs with local-import stripping for self-contained bootstrap.\n` +
    ` */\n\n` +
    `export const EMBEDDED_CLAUDE_RUNNER_SOURCE = ${JSON.stringify(embedded)};\n`;
}

async function main() {
  const runnerSource = await readFile(RUNNER_PATH, 'utf8');
  const nextOutput = toEmbeddedSource(runnerSource);

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
