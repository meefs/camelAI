import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const repoRoot = resolve(desktopDirectory, '..');
const stageDirectory = resolve(desktopDirectory, 'app-resources');
const stageBinDirectory = resolve(stageDirectory, 'bin');
const stageBackendDirectory = resolve(stageDirectory, 'backend');
const stageKernelDirectory = resolve(stageDirectory, 'kernel');
const rendererOutputDirectory = resolve(desktopDirectory, 'renderer-dist');
const runtimeKernelSourcePath = resolve(desktopDirectory, 'runtime-helper/assets/vmlinux');
const runtimeKernelStagePath = resolve(stageKernelDirectory, 'vmlinux');
const backendEntry = resolve(desktopDirectory, 'backend/server.ts');
const backendServiceEntry = resolve(desktopDirectory, 'backend/electron-service.ts');
const backendBinaryPath = resolve(stageBinDirectory, 'camelai-desktop-backend');
const backendServiceBundlePath = resolve(stageBackendDirectory, 'index.mjs');
const runtimeHelperReleasePath = resolve(desktopDirectory, 'runtime-helper/.build/release/camelai-runtime-helper');
const runtimeHelperStagePath = resolve(stageBinDirectory, 'camelai-runtime-helper');
const manifestPath = resolve(stageDirectory, 'manifest.json');

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

rmSync(stageDirectory, { recursive: true, force: true });
mkdirSync(stageBinDirectory, { recursive: true });
mkdirSync(stageBackendDirectory, { recursive: true });
mkdirSync(stageKernelDirectory, { recursive: true });

run('bun', ['x', 'vite', 'build', '--config', 'desktop/vite.config.ts']);
run('bun', ['build', '--target=node', '--format=esm', '--outfile', backendServiceBundlePath, backendServiceEntry]);
run('bun', ['build', '--compile', '--target=bun', '--outfile', backendBinaryPath, backendEntry]);
run('node', ['desktop/scripts/prepare-runtime-helper.mjs', 'release']);

cpSync(rendererOutputDirectory, resolve(stageDirectory, 'renderer'), { recursive: true, force: true });
cpSync(runtimeKernelSourcePath, runtimeKernelStagePath, { force: true });
cpSync(runtimeHelperReleasePath, runtimeHelperStagePath, { force: true });
run('node', ['desktop/scripts/sign-runtime-helper.mjs', 'desktop/app-resources/bin/camelai-runtime-helper']);
chmodSync(backendBinaryPath, 0o755);
chmodSync(runtimeHelperStagePath, 0o755);

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      rendererDirectory: 'renderer',
      kernelPath: 'kernel/vmlinux',
      backendModule: 'backend/index.mjs',
      backendBinary: 'bin/camelai-desktop-backend',
      runtimeHelperBinary: 'bin/camelai-runtime-helper',
    },
    null,
    2
  )
);

if (!existsSync(resolve(stageDirectory, 'renderer/index.html'))) {
  throw new Error('Staged renderer bundle is missing index.html.');
}

if (!existsSync(backendServiceBundlePath)) {
  throw new Error('Staged desktop service bundle is missing.');
}

if (!existsSync(runtimeKernelStagePath)) {
  throw new Error('Staged runtime kernel is missing.');
}
