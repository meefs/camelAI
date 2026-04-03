import { existsSync, realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const repoRoot = resolve(desktopDirectory, '..');
const configuration = process.argv[2] === 'release' ? 'release' : 'debug';
const helperAliasPath = resolve(
  desktopDirectory,
  `runtime-helper/.build/${configuration}/camelai-runtime-helper`,
);

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run('node', ['desktop/scripts/fetch-runtime-kernel.mjs']);
run('swift', ['build', '--package-path', 'desktop/runtime-helper', '-c', configuration]);

if (!existsSync(helperAliasPath)) {
  console.error(`Runtime helper binary not found at ${helperAliasPath}`);
  process.exit(1);
}

run('node', ['desktop/scripts/sign-runtime-helper.mjs', realpathSync(helperAliasPath)]);
