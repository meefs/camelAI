#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const repoRoot = process.cwd();
const workerdPath = path.resolve(repoRoot, 'node_modules/workerd/bin/workerd');
const bindingModulePath = path.resolve(repoRoot, 'infra/selfhost/artifacts-binding.worker.js');
const secret = process.env.LOCAL_ARTIFACTS_SECRET || 'selfhost-artifacts-smoke-secret';

function q(value) {
  return JSON.stringify(String(value));
}

function relFrom(dir, filePath) {
  return path.relative(dir, filePath).replaceAll(path.sep, '/');
}

function moduleFile(outDir, name, filePath) {
  return `(name = ${q(name)}, esModule = embed ${q(relFrom(outDir, filePath))})`;
}

function moduleSource(name, source) {
  return `(name = ${q(name)}, esModule = ${q(source)})`;
}

function bindingText(name, value) {
  return `(name = ${q(name)}, text = ${q(value)})`;
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on('error', reject);
  });
}

function spawnLogged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
  });
  child.output = [];
  child.stdout.on('data', (chunk) => child.output.push(chunk));
  child.stderr.on('data', (chunk) => child.output.push(chunk));
  return child;
}

async function waitForHttp(url, child, label) {
  let lastError;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`${label} exited early with ${child.exitCode}: ${Buffer.concat(child.output).toString('utf8')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      lastError = new Error(`${label} returned ${response.status}: ${await response.text()}`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  throw lastError ?? new Error(`Timed out waiting for ${label}`);
}

function probeWorkerSource(repoName) {
  return `
export default {
  async fetch(_request, env) {
    const created = await env.ARTIFACTS.create(${JSON.stringify(repoName)}, {
      description: "self-host Artifacts smoke test",
      setDefaultBranch: "main"
    });
    const repo = await env.ARTIFACTS.get(${JSON.stringify(repoName)});
    const writeToken = await repo.createToken("write", 600);
    const readToken = await repo.createToken("read", 600);
    return Response.json({
      created,
      repo: {
        id: repo.id,
        name: repo.name,
        remote: repo.remote,
        defaultBranch: repo.defaultBranch,
        status: repo.status
      },
      writeToken: writeToken.plaintext,
      readToken: readToken.plaintext
    });
  }
};
`;
}

async function writeProbeConfig({ dir, configPath, port, artifactsBaseUrl, repoName }) {
  const config = `using Workerd = import "/workerd/workerd.capnp";

const smoke :Workerd.Config = (
  services = [
    (name = "main", worker = (
      compatibilityDate = "2025-12-01",
      modules = [${moduleSource('worker.mjs', probeWorkerSource(repoName))}],
      bindings = [
        (name = "ARTIFACTS", wrapped = (
          moduleName = "selfhost:artifacts-binding",
          innerBindings = [
            ${bindingText('baseUrl', artifactsBaseUrl)},
            ${bindingText('secret', secret)},
            ${bindingText('defaultBranch', 'main')}
          ]
        ))
      ],
      globalOutbound = "internet"
    )),
    (name = "internet", network = (allow = ["public", "private"], tlsOptions = (trustBrowserCas = true)))
  ],
  extensions = [
    (modules = [(name = "selfhost:artifacts-binding", internal = true, esModule = embed ${q(relFrom(dir, bindingModulePath))})])
  ],
  sockets = [
    (name = "http", address = ${q(`127.0.0.1:${port}`)}, http = (), service = "main")
  ]
);
`;
  await fs.writeFile(configPath, config);
}

async function run(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: {
      ...process.env,
      ...(options.env ?? {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on('data', (chunk) => stdout.push(chunk));
  child.stderr.on('data', (chunk) => stderr.push(chunk));
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', resolve);
  });
  if (code !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed with ${code}\n${Buffer.concat(stdout).toString('utf8')}${Buffer.concat(stderr).toString('utf8')}`);
  }
  return Buffer.concat(stdout).toString('utf8');
}

async function shutdownChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.once('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2_000)),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  }
}

async function main() {
  await fs.access(workerdPath).catch(() => {
    throw new Error('Missing workerd binary. Run `bun install` first.');
  });

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camelai-artifacts-smoke-'));
  const repoRootDir = path.join(tempDir, 'repos');
  const cloneDir = path.join(tempDir, 'clone');
  const artifactsPort = await freePort();
  const probePort = await freePort();
  const artifactsBaseUrl = `http://127.0.0.1:${artifactsPort}`;
  const repoName = `smoke-${Date.now()}`;
  const configPath = path.join(tempDir, 'probe.capnp');

  const artifactsServer = spawnLogged(process.execPath, ['scripts/local-artifacts-server.mjs'], {
    env: {
      LOCAL_ARTIFACTS_HOST: '127.0.0.1',
      LOCAL_ARTIFACTS_PORT: String(artifactsPort),
      LOCAL_ARTIFACTS_REPO_ROOT: repoRootDir,
      LOCAL_ARTIFACTS_PUBLIC_BASE_URL: artifactsBaseUrl,
      LOCAL_ARTIFACTS_SECRET: secret,
    },
  });
  let probeServer;
  try {
    await waitForHttp(`${artifactsBaseUrl}/health`, artifactsServer, 'local Artifacts server');
    await writeProbeConfig({
      dir: tempDir,
      configPath,
      port: probePort,
      artifactsBaseUrl,
      repoName,
    });
    probeServer = spawnLogged(workerdPath, ['serve', configPath, 'smoke', '--experimental']);
    const response = await waitForHttp(`http://127.0.0.1:${probePort}/`, probeServer, 'Artifacts binding probe');
    const payload = await response.json();

    if (!payload.writeToken || !payload.readToken || payload.repo?.name !== repoName) {
      throw new Error(`Unexpected smoke payload: ${JSON.stringify(payload)}`);
    }

    const writeHeader = `http.extraHeader=Authorization: Bearer ${payload.writeToken}`;
    const readHeader = `http.extraHeader=Authorization: Bearer ${payload.readToken}`;
    await run('git', ['-c', writeHeader, 'clone', payload.repo.remote, cloneDir]);
    await fs.writeFile(path.join(cloneDir, 'README.md'), '# self-host Artifacts smoke\n');
    await run('git', ['config', 'user.email', 'selfhost-smoke@localhost'], { cwd: cloneDir });
    await run('git', ['config', 'user.name', 'Self Host Smoke'], { cwd: cloneDir });
    await run('git', ['add', 'README.md'], { cwd: cloneDir });
    await run('git', ['commit', '-m', 'smoke'], { cwd: cloneDir });
    await run('git', ['-c', writeHeader, 'push', 'origin', 'main'], { cwd: cloneDir });
    const refs = await run('git', ['-c', readHeader, 'ls-remote', payload.repo.remote, 'HEAD']);
    if (!refs.includes('HEAD')) {
      throw new Error(`Expected HEAD from ls-remote, received: ${refs}`);
    }

    console.log(`Self-host Artifacts smoke passed for ${repoName}.`);
  } finally {
    await Promise.all([
      shutdownChild(probeServer),
      shutdownChild(artifactsServer),
    ]);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
