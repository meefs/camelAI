#!/usr/bin/env node
/**
 * R2 sync utility using tar+zstd for efficient snapshot-based sync.
 *
 * Usage:
 *   node sync.mjs download <target-dir>
 *   node sync.mjs upload <source-dir>
 *
 * Environment variables:
 *   R2_BUCKET_NAME, R2_ACCOUNT_ID, R2_PREFIX
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (optional)
 */

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { spawn } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';

const SNAPSHOT_KEY = 'workspace.tar.zst';

function getConfig() {
  const { R2_BUCKET_NAME, R2_ACCOUNT_ID, R2_PREFIX, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN } = process.env;

  if (!R2_BUCKET_NAME || !R2_ACCOUNT_ID || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    return null;
  }

  return {
    bucket: R2_BUCKET_NAME,
    prefix: R2_PREFIX || 'default/',
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: AWS_ACCESS_KEY_ID,
      secretAccessKey: AWS_SECRET_ACCESS_KEY,
      ...(AWS_SESSION_TOKEN && { sessionToken: AWS_SESSION_TOKEN }),
    },
  };
}

function getS3Client(config) {
  return new S3Client({
    endpoint: config.endpoint,
    region: 'auto',
    credentials: config.credentials,
  });
}

async function clearDirectory(targetDir) {
  const resolved = path.resolve(targetDir);
  if (!resolved || resolved === '/') {
    throw new Error(`[sync] Refusing to wipe directory "${resolved}"`);
  }

  await fs.mkdir(resolved, { recursive: true });
  const entries = await fs.readdir(resolved);
  for (const entry of entries) {
    await fs.rm(path.join(resolved, entry), { recursive: true, force: true });
  }
}

async function download(targetDir) {
  const config = getConfig();
  if (!config) {
    console.error('[sync] No R2 credentials configured, skipping download');
    return false;
  }

  const client = getS3Client(config);
  const key = `${config.prefix}${SNAPSHOT_KEY}`;

  // Check if snapshot exists
  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.error(`[sync] No snapshot found at ${key}, starting fresh`);
      return true;
    }
    throw err;
  }

  console.error(`[sync] Downloading snapshot from ${key}...`);
  const startTime = Date.now();

  console.error(`[sync] Clearing ${targetDir} before restore...`);
  await clearDirectory(targetDir);

  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));

  // Pipe: S3 stream -> zstd -d -> tar x
  const zstd = spawn('zstd', ['-d'], { stdio: ['pipe', 'pipe', 'inherit'] });
  const tar = spawn('tar', ['xf', '-', '-C', targetDir], { stdio: ['pipe', 'inherit', 'inherit'] });

  zstd.stdout.pipe(tar.stdin);

  await Promise.all([
    pipeline(response.Body, zstd.stdin),
    new Promise((resolve, reject) => {
      tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
      tar.on('error', reject);
    }),
    new Promise((resolve, reject) => {
      zstd.on('close', (code) => code === 0 ? resolve() : reject(new Error(`zstd exited with ${code}`)));
      zstd.on('error', reject);
    }),
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[sync] Download complete in ${elapsed}s`);
  return true;
}

async function upload(sourceDir) {
  const config = getConfig();
  if (!config) {
    console.error('[sync] No R2 credentials configured, skipping upload');
    return false;
  }

  const readonly = process.env.R2_MOUNT_READONLY;
  if (readonly === '1' || readonly === 'true' || readonly === 'TRUE') {
    console.error('[sync] R2_MOUNT_READONLY set, skipping upload');
    return true;
  }

  console.error(`[sync] Creating snapshot of ${sourceDir}...`);
  const startTime = Date.now();

  // Pipe: tar c -> zstd -> stream -> S3
  const tar = spawn('tar', ['cf', '-', '-C', sourceDir, '.'], { stdio: ['inherit', 'pipe', 'inherit'] });
  const zstd = spawn('zstd', ['-1', '-T0'], { stdio: ['pipe', 'pipe', 'inherit'] });

  tar.stdout.pipe(zstd.stdin);

  let totalBytes = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      totalBytes += chunk.length;
      callback(null, chunk);
    },
  });

  zstd.stdout.pipe(counter);

  const client = getS3Client(config);
  const key = `${config.prefix}${SNAPSHOT_KEY}`;

  const uploadPromise = client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: counter,
    ContentType: 'application/zstd',
  })).catch((err) => {
    tar.kill('SIGTERM');
    zstd.kill('SIGTERM');
    counter.destroy(err);
    throw err;
  });

  const tarExit = new Promise((resolve, reject) => {
    tar.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const err = new Error(`tar exited with ${code}`);
      counter.destroy(err);
      reject(err);
    });
    tar.on('error', (err) => {
      counter.destroy(err);
      reject(err);
    });
  });

  const zstdExit = new Promise((resolve, reject) => {
    zstd.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      const err = new Error(`zstd exited with ${code}`);
      counter.destroy(err);
      reject(err);
    });
    zstd.on('error', (err) => {
      counter.destroy(err);
      reject(err);
    });
  });

  await Promise.all([uploadPromise, tarExit, zstdExit]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
  console.error(`[sync] Upload complete (${sizeMB}MB) in ${elapsed}s`);
  return true;
}

// CLI entry point
const [,, command, dir] = process.argv;

if (!command || !dir) {
  console.error('Usage: node sync.mjs <download|upload> <directory>');
  process.exit(1);
}

try {
  if (command === 'download') {
    await download(dir);
  } else if (command === 'upload') {
    await upload(dir);
  } else {
    console.error(`Unknown command: ${command}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[sync] Error: ${err.message}`);
  process.exit(1);
}
