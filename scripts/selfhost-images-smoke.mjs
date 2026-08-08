#!/usr/bin/env node

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import sharp from 'sharp';
import { startSelfhostLoopbackServer } from './selfhost-loopback-server.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workerdPath = path.join(repoRoot, 'node_modules/workerd/bin/workerd');
const miniflareWorkersDir = path.join(repoRoot, 'node_modules/miniflare/dist/src/workers');

function q(value) {
  return JSON.stringify(String(value));
}

function moduleEmbed(tempDir, name, filePath) {
  const relative = path.relative(tempDir, filePath).replaceAll(path.sep, '/');
  return `(name = ${q(name)}, esModule = embed ${q(relative)})`;
}

function moduleSource(name, source) {
  return `(name = ${q(name)}, esModule = ${q(source)})`;
}

async function freePort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  if (!address || typeof address === 'string') throw new Error('Failed to reserve a smoke-test port');
  return address.port;
}

async function waitForServer(url, child, logs) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`workerd exited before Images smoke test was ready\n${logs.join('')}`);
    }
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      // The workerd socket is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for self-host Images smoke test\n${logs.join('')}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function main() {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'camelai-selfhost-images-'));
  const configPath = path.join(tempDir, 'images.capnp');
  const port = await freePort();
  const sourcePng = await sharp({
    create: {
      width: 4,
      height: 3,
      channels: 4,
      background: { r: 16, g: 96, b: 224, alpha: 1 },
    },
  }).png().toBuffer();
  const sourceBase64 = sourcePng.toString('base64');
  const mainWorkerSource = `
const SOURCE = Uint8Array.from(atob(${JSON.stringify(sourceBase64)}), (char) => char.charCodeAt(0));
function sourceStream() {
  return new ReadableStream({ start(controller) { controller.enqueue(SOURCE); controller.close(); } });
}
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/info") {
      return Response.json(await env.IMAGES.info(sourceStream()));
    }
    const output = await env.IMAGES.input(sourceStream())
      .transform({ width: 2, height: 2, fit: "scale-down" })
      .output({ format: "image/webp", quality: 80, anim: false });
    return output.response();
  }
};`;

  const supportModules = [
    moduleEmbed(tempDir, 'miniflare:shared', path.join(miniflareWorkersDir, 'shared/index.worker.js')),
    moduleEmbed(tempDir, 'miniflare:zod', path.join(miniflareWorkersDir, 'shared/zod.worker.js')),
    moduleSource(
      'node-internal:internal_assert',
      'import assert from "node:assert"; export default assert; export * from "node:assert";',
    ),
    moduleSource('node-internal:internal_buffer', 'export { Buffer } from "node:buffer";'),
  ];
  const config = `using Workerd = import "/workerd/workerd.capnp";

const smoke :Workerd.Config = (
  services = [
    (name = "main", worker = (
      compatibilityDate = "2026-03-24",
      modules = [${moduleSource('main.worker.js', mainWorkerSource)}],
      bindings = [
        (name = "IMAGES", wrapped = (
          moduleName = "cloudflare-internal:images-api",
          innerBindings = [(name = "fetcher", service = (name = "images:service"))]
        ))
      ]
    )),
    (name = "images:service", worker = (
      compatibilityDate = "2025-04-01",
      compatibilityFlags = ["nodejs_compat"],
      modules = [
        ${moduleEmbed(tempDir, 'images.worker.js', path.join(miniflareWorkersDir, 'images/images.worker.js'))},
        ${supportModules.join(',\n        ')}
      ],
      bindings = [(name = "MINIFLARE_LOOPBACK", service = (name = "loopback"))]
    )),
    (name = "loopback", external = (http = ()))
  ],
  sockets = [(name = "http", address = ${q(`127.0.0.1:${port}`)}, http = (), service = "main")]
);`;
  await fs.writeFile(configPath, config);

  const loopback = await startSelfhostLoopbackServer();
  const logs = [];
  const child = spawn(workerdPath, [
    'serve',
    configPath,
    'smoke',
    '--experimental',
    `--external-addr=loopback=${loopback.hostname}:${loopback.port}`,
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (chunk) => logs.push(chunk.toString()));
  child.stderr.on('data', (chunk) => logs.push(chunk.toString()));

  try {
    const infoResponse = await waitForServer(`http://127.0.0.1:${port}/info`, child, logs);
    const info = await infoResponse.json();
    if (info.format !== 'image/png' || info.width !== 4 || info.height !== 3) {
      throw new Error(`Unexpected Images info response: ${JSON.stringify(info)}`);
    }

    const transformedResponse = await fetch(`http://127.0.0.1:${port}/transform`);
    if (!transformedResponse.ok) {
      throw new Error(`Images transform failed: ${transformedResponse.status} ${await transformedResponse.text()}`);
    }
    if (transformedResponse.headers.get('content-type') !== 'image/webp') {
      throw new Error(`Unexpected Images content type: ${transformedResponse.headers.get('content-type')}`);
    }
    const transformed = Buffer.from(await transformedResponse.arrayBuffer());
    const metadata = await sharp(transformed).metadata();
    if (metadata.format !== 'webp' || metadata.width !== 2 || metadata.height !== 2) {
      throw new Error(`Unexpected transformed image: ${JSON.stringify(metadata)}`);
    }
    console.log('Self-host Images binding smoke test passed.');
  } finally {
    await stopChild(child);
    await loopback.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
