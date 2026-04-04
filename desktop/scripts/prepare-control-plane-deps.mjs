import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopDirectory = resolve(scriptDirectory, '..');
const controlPlaneDirectory = resolve(desktopDirectory, 'control-plane');
const nodeModulesDirectory = resolve(controlPlaneDirectory, 'node_modules');
const codexPackagePath = resolve(nodeModulesDirectory, '@openai/codex/package.json');
const codexLinuxArm64Directory = resolve(
  nodeModulesDirectory,
  '@openai/codex-linux-arm64',
);
const codexLinuxArm64PackagePath = resolve(
  codexLinuxArm64Directory,
  'package.json',
);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: controlPlaneDirectory,
    stdio: 'inherit',
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readInstalledCodexVersion() {
  if (!existsSync(codexPackagePath)) {
    fail(`Missing installed Codex package at ${codexPackagePath}`);
  }

  const packageJson = JSON.parse(readFileSync(codexPackagePath, 'utf8'));
  const version = packageJson?.version;
  if (typeof version !== 'string' || version.trim().length === 0) {
    fail(`Unable to determine installed Codex version from ${codexPackagePath}`);
  }
  return version.trim();
}

function ensureLinuxArm64CodexBinary(version) {
  if (existsSync(codexLinuxArm64PackagePath)) {
    return;
  }

  mkdirSync(resolve(nodeModulesDirectory, '@openai'), { recursive: true });
  rmSync(codexLinuxArm64Directory, { recursive: true, force: true });
  mkdirSync(codexLinuxArm64Directory, { recursive: true });

  const tarballUrl = `https://registry.npmjs.org/@openai/codex/-/codex-${version}-linux-arm64.tgz`;
  const result = spawnSync(
    'sh',
    [
      '-lc',
      `curl -L --fail ${JSON.stringify(tarballUrl)} | tar -xz -C ${JSON.stringify(
        codexLinuxArm64Directory,
      )} --strip-components=1`,
    ],
    {
      cwd: controlPlaneDirectory,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  if (!existsSync(codexLinuxArm64PackagePath)) {
    fail(`Codex Linux arm64 package did not materialize at ${codexLinuxArm64PackagePath}`);
  }
}

if (!existsSync(codexPackagePath) || !existsSync(codexLinuxArm64PackagePath)) {
  run('npm', ['ci', '--omit=dev', '--ignore-scripts']);
}

ensureLinuxArm64CodexBinary(readInstalledCodexVersion());
