import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const repoRoot = resolve(desktopDirectory, '..');
const entitlementsPath = resolve(desktopDirectory, 'build/entitlements.vm-helper.plist');
const targetPath = process.argv[2];

if (!targetPath) {
  console.error('usage: node desktop/scripts/sign-vm-helper.mjs <binary-path>');
  process.exit(1);
}

const resolvedTargetPath = resolve(repoRoot, targetPath);
if (!existsSync(resolvedTargetPath)) {
  console.error(`VM helper binary not found at ${resolvedTargetPath}`);
  process.exit(1);
}

function resolveSigningIdentity() {
  if (process.env.DESKTOP_VM_HELPER_SIGN_IDENTITY) {
    return process.env.DESKTOP_VM_HELPER_SIGN_IDENTITY;
  }
  return '-';
}

const signingIdentity = resolveSigningIdentity();

const result = spawnSync(
  'codesign',
  [
    '--force',
    '--sign',
    signingIdentity,
    '--entitlements',
    entitlementsPath,
    resolvedTargetPath,
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: process.env,
  }
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
