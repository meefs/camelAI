/**
 * Build sprite bootstrap assets (tarballs) for static serving.
 *
 * Generates:
 * - public/assets/sprite/runner-<hash>.tar.gz (claude-runner.mjs + memory-logger.mjs)
 * - public/assets/sprite/skills-<hash>.tar.gz (sandbox/skills/)
 * - public/assets/sprite/create-worker-<hash>.tar.gz (sandbox/create-worker/)
 * - workers/main/src/sprite-assets-manifest.ts (URLs + hashes for the worker)
 */

import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');
const ASSETS_DIR = resolve(ROOT_DIR, 'public/assets/sprite');
const MANIFEST_PATH = resolve(ROOT_DIR, 'workers/main/src/sprite-assets-manifest.ts');

// Source paths
const RUNNER_PATH = resolve(ROOT_DIR, 'sandbox/claude-runner.mjs');
const MEMORY_LOGGER_PATH = resolve(ROOT_DIR, 'sandbox/memory-logger.mjs');
const SKILLS_DIR = resolve(ROOT_DIR, 'sandbox/skills');
const CREATE_WORKER_DIR = resolve(ROOT_DIR, 'sandbox/create-worker');

function toPosixPath(path) {
  return path.split(sep).join('/');
}

function toFileMode(fileStat) {
  return (fileStat.mode & 0o111) !== 0 ? 0o755 : 0o644;
}

function writeTarString(buffer, offset, length, value) {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length > length) {
    throw new Error(`Tar field overflow (${bytes.length} > ${length}) for value: ${value}`);
  }
  bytes.copy(buffer, offset);
}

function toTarOctal(value, width) {
  const octal = Math.max(0, value).toString(8);
  if (octal.length > width - 1) {
    throw new Error(`Value ${value} does not fit in ${width} byte octal field`);
  }
  return `${octal.padStart(width - 1, '0')}\0`;
}

function createTarHeader(path, mode, size, isDir = false) {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, path);
  writeTarString(header, 100, 8, toTarOctal(mode, 8));
  writeTarString(header, 108, 8, toTarOctal(0, 8)); // uid
  writeTarString(header, 116, 8, toTarOctal(0, 8)); // gid
  writeTarString(header, 124, 12, toTarOctal(size, 12));
  writeTarString(header, 136, 12, toTarOctal(0, 12)); // deterministic mtime
  header.fill(0x20, 148, 156); // checksum placeholder
  header[156] = isDir ? 0x35 : 0x30; // '5' for dir, '0' for file
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumField = `${checksum.toString(8).padStart(6, '0')}\0 `;
  writeTarString(header, 148, 8, checksumField);
  return header;
}

async function collectFiles(rootDir, prefix = '') {
  const out = [];

  async function walk(currentDir) {
    const entries = await readdir(currentDir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const fullPath = resolve(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;

      const bytes = await readFile(fullPath);
      const fileStat = await stat(fullPath);
      const relativePath = toPosixPath(relative(rootDir, fullPath));
      out.push({
        path: prefix ? `${prefix}/${relativePath}` : relativePath,
        mode: toFileMode(fileStat),
        content: bytes,
      });
    }
  }

  await walk(rootDir);
  return out;
}

function buildTarGzip(entries) {
  const chunks = [];

  for (const entry of entries) {
    if (Buffer.byteLength(entry.path, 'utf8') > 100) {
      throw new Error(`Archive path exceeds tar header name limit: ${entry.path}`);
    }

    chunks.push(createTarHeader(entry.path, entry.mode, entry.content.length));
    chunks.push(entry.content);

    const pad = (512 - (entry.content.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }

  chunks.push(Buffer.alloc(1024, 0)); // two EOF blocks
  const tarBytes = Buffer.concat(chunks);
  return gzipSync(tarBytes, { level: 9, mtime: 0 });
}

function computeHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

async function buildRunnerAsset() {
  const [runnerSource, memoryLoggerSource] = await Promise.all([
    readFile(RUNNER_PATH),
    readFile(MEMORY_LOGGER_PATH),
  ]);

  const entries = [
    { path: 'claude-runner.mjs', mode: 0o755, content: runnerSource },
    { path: 'memory-logger.mjs', mode: 0o644, content: memoryLoggerSource },
  ];

  const tarGz = buildTarGzip(entries);
  const hash = computeHash(tarGz);
  const filename = `runner-${hash}.tar.gz`;

  return { filename, content: tarGz, hash };
}

async function buildSkillsAsset() {
  const entries = await collectFiles(SKILLS_DIR, 'skills');
  const tarGz = buildTarGzip(entries);
  const hash = computeHash(tarGz);
  const filename = `skills-${hash}.tar.gz`;

  return { filename, content: tarGz, hash };
}

async function buildCreateWorkerAsset() {
  const entries = await collectFiles(CREATE_WORKER_DIR, 'create-worker');
  const tarGz = buildTarGzip(entries);
  const hash = computeHash(tarGz);
  const filename = `create-worker-${hash}.tar.gz`;

  return { filename, content: tarGz, hash };
}

function generateManifest(assets) {
  const lines = [
    '/**',
    ' * Sprite bootstrap asset manifest.',
    ' * Generated by scripts/build-sprite-assets.mjs - do not edit manually.',
    ' */',
    '',
    'export interface SpriteAsset {',
    '  filename: string;',
    '  hash: string;',
    '  path: string;',
    '}',
    '',
    'export const SPRITE_ASSETS = {',
  ];

  for (const [name, asset] of Object.entries(assets)) {
    lines.push(`  ${name}: {`);
    lines.push(`    filename: ${JSON.stringify(asset.filename)},`);
    lines.push(`    hash: ${JSON.stringify(asset.hash)},`);
    lines.push(`    path: ${JSON.stringify(`/assets/sprite/${asset.filename}`)},`);
    lines.push('  },');
  }

  lines.push('} as const;');
  lines.push('');
  lines.push('// Composite version for bootstrap caching');
  lines.push(`export const SPRITE_BOOTSTRAP_VERSION = ${JSON.stringify(
    Object.values(assets).map(a => a.hash).join(':')
  )};`);
  lines.push('');

  return lines.join('\n');
}

async function cleanOldAssets(currentFilenames) {
  try {
    const existing = await readdir(ASSETS_DIR);
    for (const file of existing) {
      if (file.endsWith('.tar.gz') && !currentFilenames.includes(file)) {
        await rm(resolve(ASSETS_DIR, file));
        console.log(`[sprite-assets] removed old asset: ${file}`);
      }
    }
  } catch {
    // Directory may not exist yet
  }
}

async function main() {
  console.log('[sprite-assets] building sprite bootstrap assets...');

  // Build all assets in parallel
  const [runner, skills, createWorker] = await Promise.all([
    buildRunnerAsset(),
    buildSkillsAsset(),
    buildCreateWorkerAsset(),
  ]);

  const assets = { runner, skills, createWorker };

  // Ensure output directory exists
  await mkdir(ASSETS_DIR, { recursive: true });

  // Clean old assets
  await cleanOldAssets([runner.filename, skills.filename, createWorker.filename]);

  // Write assets
  for (const [name, asset] of Object.entries(assets)) {
    const assetPath = resolve(ASSETS_DIR, asset.filename);
    await writeFile(assetPath, asset.content);
    console.log(`[sprite-assets] wrote ${name}: ${asset.filename} (${asset.content.length} bytes)`);
  }

  // Generate manifest
  const manifest = generateManifest(assets);

  let currentManifest = '';
  try {
    currentManifest = await readFile(MANIFEST_PATH, 'utf8');
  } catch {
    // File may not exist
  }

  if (currentManifest !== manifest) {
    await writeFile(MANIFEST_PATH, manifest, 'utf8');
    console.log('[sprite-assets] updated sprite-assets-manifest.ts');
  } else {
    console.log('[sprite-assets] manifest up to date');
  }

  console.log('[sprite-assets] done');
}

main().catch((error) => {
  console.error('[sprite-assets] failed:', error);
  process.exit(1);
});
