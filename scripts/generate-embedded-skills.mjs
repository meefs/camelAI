import { createHash } from 'node:crypto';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(SCRIPT_DIR, '..');

const SKILLS_DIR = resolve(ROOT_DIR, 'sandbox/skills');
const OUT_PATH = resolve(ROOT_DIR, 'workers/main/src/embedded-skills.ts');

function toPosixPath(path) {
  return path.split(sep).join('/');
}

function toFileMode(fileStat) {
  return (fileStat.mode & 0o111) !== 0 ? '0755' : '0644';
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

function createTarHeader(path, mode, size) {
  const header = Buffer.alloc(512, 0);
  writeTarString(header, 0, 100, path);
  writeTarString(header, 100, 8, toTarOctal(mode, 8));
  writeTarString(header, 108, 8, toTarOctal(0, 8));
  writeTarString(header, 116, 8, toTarOctal(0, 8));
  writeTarString(header, 124, 12, toTarOctal(size, 12));
  writeTarString(header, 136, 12, toTarOctal(0, 12)); // deterministic mtime
  header.fill(0x20, 148, 156); // checksum placeholder
  header[156] = 0x30; // '0' file entry
  writeTarString(header, 257, 6, 'ustar\0');
  writeTarString(header, 263, 2, '00');

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const checksumField = `${checksum.toString(8).padStart(6, '0')}\0 `;
  writeTarString(header, 148, 8, checksumField);
  return header;
}

async function collectFiles(rootDir) {
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
      out.push({
        path: toPosixPath(relative(rootDir, fullPath)),
        mode: toFileMode(fileStat),
        contentBase64: bytes.toString('base64'),
      });
    }
  }

  await walk(rootDir);
  return out;
}

function buildTarGzipBase64(entries) {
  const chunks = [];

  for (const entry of entries) {
    const archivePath = `skills/${entry.path}`;
    if (Buffer.byteLength(archivePath, 'utf8') > 100) {
      throw new Error(`Archive path exceeds tar header name limit: ${archivePath}`);
    }

    const bytes = Buffer.from(entry.contentBase64, 'base64');
    const mode = Number.parseInt(entry.mode, 8);
    chunks.push(createTarHeader(archivePath, mode, bytes.length));
    chunks.push(bytes);

    const pad = (512 - (bytes.length % 512)) % 512;
    if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
  }

  chunks.push(Buffer.alloc(1024, 0)); // two EOF blocks
  const tarBytes = Buffer.concat(chunks);
  const gzBytes = gzipSync(tarBytes, { level: 9, mtime: 0 });
  return gzBytes.toString('base64');
}

function buildVersion(entries) {
  const hash = createHash('sha256');
  for (const entry of entries) {
    hash.update(entry.path);
    hash.update('\0');
    hash.update(entry.mode);
    hash.update('\0');
    hash.update(entry.contentBase64);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function toOutput(version, archiveBase64) {
  return `/**\n` +
    ` * Embedded tar.gz payload uploaded and extracted into /etc/claude-code/.claude.\n` +
    ` * Generated from sandbox/skills.\n` +
    ` */\n\n` +
    `export const EMBEDDED_SKILLS_VERSION = ${JSON.stringify(version)};\n\n` +
    `export const EMBEDDED_SKILLS_ARCHIVE_BASE64 = ${JSON.stringify(archiveBase64)};\n`;
}

async function main() {
  const entries = await collectFiles(SKILLS_DIR);
  const version = buildVersion(entries);
  const archiveBase64 = buildTarGzipBase64(entries);
  const nextOutput = toOutput(version, archiveBase64);

  let currentOutput = '';
  try {
    currentOutput = await readFile(OUT_PATH, 'utf8');
  } catch {
    // File may not exist yet.
  }

  if (currentOutput === nextOutput) {
    console.log('[gen:embedded-skills] up to date');
    return;
  }

  await writeFile(OUT_PATH, nextOutput, 'utf8');
  console.log('[gen:embedded-skills] updated workers/main/src/embedded-skills.ts');
}

main().catch((error) => {
  console.error('[gen:embedded-skills] failed:', error);
  process.exit(1);
});
