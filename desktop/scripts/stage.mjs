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
const stageVmApplianceDirectory = resolve(stageDirectory, 'vm-appliance');
const rendererOutputDirectory = resolve(desktopDirectory, 'renderer-dist');
const guestSourceDirectory = resolve(desktopDirectory, 'guest');
const guestStageDirectory = resolve(stageDirectory, 'guest');
const defaultApplianceDiskPath = resolve(desktopDirectory, '.local/vm/disk.raw');
const backendEntry = resolve(desktopDirectory, 'backend/server.ts');
const backendServiceEntry = resolve(desktopDirectory, 'backend/electron-service.ts');
const backendBinaryPath = resolve(stageBinDirectory, 'camelai-desktop-backend');
const backendServiceBundlePath = resolve(stageBackendDirectory, 'index.mjs');
const vmHelperReleasePath = resolve(desktopDirectory, 'vm-helper/.build/release/camelai-vm-helper');
const vmHelperStagePath = resolve(stageBinDirectory, 'camelai-vm-helper');
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

function copyGuestBundle() {
  cpSync(guestSourceDirectory, guestStageDirectory, {
    recursive: true,
    force: true,
  });
}

function copyVmAppliance() {
  const applianceDiskPath =
    process.env.DESKTOP_VM_APPLIANCE_IMAGE_PATH || defaultApplianceDiskPath;

  if (!existsSync(applianceDiskPath)) {
    throw new Error(
      `VM appliance disk is missing: ${applianceDiskPath}. Set DESKTOP_VM_APPLIANCE_IMAGE_PATH or prepare desktop/.local/vm/disk.raw.`,
    );
  }

  mkdirSync(stageVmApplianceDirectory, { recursive: true });
  const stagedDiskPath = resolve(stageVmApplianceDirectory, 'disk.raw');
  const result = spawnSync('/bin/cp', ['-c', applianceDiskPath, stagedDiskPath], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
  });

  if (result.status !== 0) {
    throw new Error(
      [
        'Failed to clone the VM appliance disk into the staged app resources.',
        result.stderr.trim() || result.stdout.trim(),
        'The staging directory must live on an APFS volume with clonefile support.',
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
}

rmSync(stageDirectory, { recursive: true, force: true });
mkdirSync(stageBinDirectory, { recursive: true });
mkdirSync(stageBackendDirectory, { recursive: true });
mkdirSync(stageVmApplianceDirectory, { recursive: true });

run('bun', ['x', 'vite', 'build', '--config', 'desktop/vite.config.ts']);
run('bun', ['build', '--target=node', '--format=esm', '--outfile', backendServiceBundlePath, backendServiceEntry]);
run('bun', ['build', '--compile', '--target=bun', '--outfile', backendBinaryPath, backendEntry]);
run('swift', ['build', '--package-path', 'desktop/vm-helper', '-c', 'release']);

cpSync(rendererOutputDirectory, resolve(stageDirectory, 'renderer'), { recursive: true, force: true });
copyGuestBundle();
copyVmAppliance();
cpSync(vmHelperReleasePath, vmHelperStagePath, { force: true });
run('node', ['desktop/scripts/sign-vm-helper.mjs', 'desktop/app-resources/bin/camelai-vm-helper']);
chmodSync(backendBinaryPath, 0o755);
chmodSync(vmHelperStagePath, 0o755);

writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      rendererDirectory: 'renderer',
      guestDirectory: 'guest',
      vmApplianceDisk: 'vm-appliance/disk.raw',
      backendModule: 'backend/index.mjs',
      backendBinary: 'bin/camelai-desktop-backend',
      vmHelperBinary: 'bin/camelai-vm-helper',
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

if (!existsSync(resolve(guestStageDirectory, 'control-plane.mjs'))) {
  throw new Error('Staged guest bundle is missing control-plane.mjs.');
}

if (!existsSync(resolve(stageVmApplianceDirectory, 'disk.raw'))) {
  throw new Error('Staged VM appliance disk is missing.');
}
