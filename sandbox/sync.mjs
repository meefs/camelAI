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

import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand, CreateMultipartUploadCommand, UploadPartCommand, CompleteMultipartUploadCommand, AbortMultipartUploadCommand } from '@aws-sdk/client-s3';
import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { pipeline } from 'stream/promises';

const MIN_PART_SIZE = 5 * 1024 * 1024; // 5MB minimum for multipart
const MAX_CONCURRENT_UPLOADS = 4; // Parallel part uploads

const SNAPSHOT_KEY = 'workspace.tar.zst';

// Check if tar with zstd support is available
function checkBinaries() {
  try {
    execSync('tar --zstd -cf /dev/null --files-from /dev/null 2>/dev/null', { stdio: 'pipe' });
    return true;
  } catch {
    console.error('[sync] tar with --zstd support not available');
    return false;
  }
}

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

const SAFE_RM_ERRORS = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM']);

async function rmRecursiveSafe(targetPath, attempts = 3) {
  for (let i = 0; i < attempts; i++) {
    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!SAFE_RM_ERRORS.has(err.code)) {
        throw err;
      }
      if (i === attempts - 1) {
        console.error(`[sync] Warning: failed to remove ${targetPath}: ${err.message}`);
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 50 * (i + 1)));
    }
  }
}

async function clearDirectory(targetDir) {
  const resolved = path.resolve(targetDir);
  if (!resolved || resolved === '/') {
    throw new Error(`Refusing to wipe directory "${resolved}"`);
  }

  await fs.mkdir(resolved, { recursive: true });
  const entries = await fs.readdir(resolved);
  for (const entry of entries) {
    await rmRecursiveSafe(path.join(resolved, entry));
  }
}

async function download(targetDir) {
  if (!checkBinaries()) {
    throw new Error('tar with --zstd support not available');
  }

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
      console.error('[sync] No snapshot found, starting fresh');
      return true;
    }
    throw err;
  }

  console.error('[sync] Downloading snapshot...');
  const startTime = Date.now();

  // Ensure target directory exists (but don't clear it - preserve files not in backup)
  await fs.mkdir(targetDir, { recursive: true });

  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));

  // Pipe: S3 stream -> tar --zstd -x
  const tar = spawn('tar', ['--zstd', '-xf', '-', '-C', targetDir], { stdio: ['pipe', 'inherit', 'inherit'] });

  await Promise.all([
    pipeline(response.Body, tar.stdin),
    new Promise((resolve, reject) => {
      tar.on('close', (code) => {
        if (code === 0 || code === 1) {
          return resolve();
        }
        return reject(new Error(`tar exited with ${code}`));
      });
      tar.on('error', reject);
    }),
  ]);

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.error(`[sync] Download complete in ${elapsed}s`);
  return true;
}

async function upload(sourceDir) {
  if (!checkBinaries()) {
    throw new Error('tar with --zstd support not available');
  }

  // Check source directory exists
  const stats = await fs.stat(sourceDir);
  if (!stats.isDirectory()) {
    throw new Error(`${sourceDir} is not a directory`);
  }

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

  const startTime = Date.now();

  // Pipe: tar --zstd -> multipart upload
  const tar = spawn('tar', [
    '--zstd',
    '--warning=no-file-changed',
    '--warning=no-file-removed',
    '--ignore-failed-read',
    '-cf', '-',
    '-C', sourceDir,
    '.'
  ], { stdio: ['inherit', 'pipe', 'pipe'] });

  const client = getS3Client(config);
  const key = `${config.prefix}${SNAPSHOT_KEY}`;

  // Start multipart upload
  const createResp = await client.send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: 'application/zstd',
  }));
  const uploadId = createResp.UploadId;

  const parts = [];
  const uploadPromises = [];
  let partNumber = 1;
  let currentBuffer = [];
  let currentSize = 0;
  let totalBytes = 0;
  let activeUploads = 0;

  // Track exit from tar
  let tarExited = false;
  tar.on('exit', () => { tarExited = true; });

  // Upload a part with concurrency limiting
  const uploadPart = async (partNum, data) => {
    while (activeUploads >= MAX_CONCURRENT_UPLOADS) {
      await new Promise(r => setTimeout(r, 10));
    }
    activeUploads++;
    try {
      const uploadResp = await client.send(new UploadPartCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNum,
        Body: data,
        ContentLength: data.length,
      }));
      parts.push({ PartNumber: partNum, ETag: uploadResp.ETag });
    } finally {
      activeUploads--;
    }
  };

  try {
    // Stream chunks and upload as parts when we hit 5MB
    // R2 requires all non-trailing parts to be EXACTLY the same size
    for await (const chunk of tar.stdout) {
      currentBuffer.push(chunk);
      currentSize += chunk.length;
      totalBytes += chunk.length;

      // Upload exactly MIN_PART_SIZE bytes, keep remainder for next part
      while (currentSize >= MIN_PART_SIZE) {
        const fullBuffer = Buffer.concat(currentBuffer);
        const partData = fullBuffer.subarray(0, MIN_PART_SIZE);
        const remainder = fullBuffer.subarray(MIN_PART_SIZE);

        uploadPromises.push(uploadPart(partNumber, partData));
        partNumber++;

        currentBuffer = remainder.length > 0 ? [remainder] : [];
        currentSize = remainder.length;
      }
    }

    // Wait for tar to finish
    await new Promise((resolve, reject) => {
      if (tarExited) return resolve();
      tar.on('close', (code) => {
        if (code === 0 || code === 1) {
          return resolve();
        }
        return reject(new Error(`tar exited with ${code}`));
      });
      tar.on('error', reject);
    });

    // Wait for all in-flight uploads to complete
    await Promise.all(uploadPromises);

    // If we never uploaded any parts, data is < 5MB - abort multipart and use simple upload
    if (parts.length === 0) {
      await client.send(new AbortMultipartUploadCommand({
        Bucket: config.bucket,
        Key: key,
        UploadId: uploadId,
      })).catch(() => {});

      const buffer = Buffer.concat(currentBuffer);
      await client.send(new PutObjectCommand({
        Bucket: config.bucket,
        Key: key,
        Body: buffer,
        ContentType: 'application/zstd',
        ContentLength: buffer.length,
      }));

      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const sizeMB = (buffer.length / 1024 / 1024).toFixed(1);
      console.error(`[sync] Upload complete (${sizeMB}MB) in ${elapsed}s`);
      return true;
    }

    // Upload remaining data as final part
    if (currentSize > 0) {
      const partData = Buffer.concat(currentBuffer);
      await uploadPart(partNumber, partData);
    }

    // Sort parts by PartNumber (required for CompleteMultipartUpload)
    parts.sort((a, b) => a.PartNumber - b.PartNumber);

    // Complete the multipart upload
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
    console.error(`[sync] Upload complete (${sizeMB}MB, ${parts.length} parts) in ${elapsed}s`);
    return true;

  } catch (err) {
    // Abort the multipart upload on error
    console.error('[sync] Upload failed:', err.message);
    await client.send(new AbortMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
    })).catch(() => {});
    tar.kill('SIGTERM');
    throw err;
  }
}

// CLI entry point
const [,, command, dir] = process.argv;

if (!command || !dir) {
  console.error('Usage: node sync.mjs <download|upload> <directory>');
  process.exit(1);
}

// Ignore SIGPIPE (can happen if tar/zstd close unexpectedly)
process.on('SIGPIPE', () => {});

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
