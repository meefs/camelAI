#!/usr/bin/env node
/**
 * R2 sync utility using tar+zstd for efficient snapshot-based sync.
 * Version: 5 (2024-12-30) - Fixed R2 requirement: all non-trailing parts must be exactly same size
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

// Check if required binaries are available
function checkBinaries() {
  const binaries = ['tar', 'zstd'];
  const missing = [];

  for (const bin of binaries) {
    try {
      execSync(`which ${bin}`, { stdio: 'pipe' });
    } catch {
      missing.push(bin);
    }
  }

  if (missing.length > 0) {
    console.error(`[sync] Missing required binaries: ${missing.join(', ')}`);
    return false;
  }

  console.error('[sync] All required binaries available (tar, zstd)');
  return true;
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
  console.error('[sync] download() called with:', targetDir);

  // Check binaries first
  if (!checkBinaries()) {
    throw new Error('Required binaries (tar, zstd) not available');
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
  console.error('[sync] upload() called with:', sourceDir);

  // Check binaries first
  if (!checkBinaries()) {
    throw new Error('Required binaries (tar, zstd) not available');
  }

  // Check source directory exists and is accessible
  try {
    const stats = await fs.stat(sourceDir);
    if (!stats.isDirectory()) {
      throw new Error(`${sourceDir} is not a directory`);
    }
    console.error(`[sync] Source directory exists: ${sourceDir}`);
  } catch (err) {
    console.error(`[sync] Cannot access source directory: ${err.message}`);
    throw err;
  }

  const config = getConfig();
  if (!config) {
    console.error('[sync] No R2 credentials configured, skipping upload');
    return false;
  }
  console.error('[sync] Config loaded, bucket:', config.bucket, 'prefix:', config.prefix);

  const readonly = process.env.R2_MOUNT_READONLY;
  if (readonly === '1' || readonly === 'true' || readonly === 'TRUE') {
    console.error('[sync] R2_MOUNT_READONLY set, skipping upload');
    return true;
  }

  console.error(`[sync] Creating snapshot of ${sourceDir}...`);
  const startTime = Date.now();

  // Pipe: tar c -> zstd -> multipart upload (streams 5MB chunks)
  console.error('[sync] Spawning tar...');
  const tar = spawn('tar', ['cf', '-', '-C', sourceDir, '.'], { stdio: ['inherit', 'pipe', 'pipe'] });
  console.error('[sync] Spawning zstd...');
  const zstd = spawn('zstd', ['-1', '-T0'], { stdio: ['pipe', 'pipe', 'pipe'] });

  // Log stderr from tar/zstd for debugging
  tar.stderr.on('data', (data) => console.error(`[sync] tar stderr: ${data.toString().trim()}`));
  zstd.stderr.on('data', (data) => console.error(`[sync] zstd stderr: ${data.toString().trim()}`));
  tar.on('error', (err) => console.error('[sync] tar spawn error:', err.message));
  zstd.on('error', (err) => console.error('[sync] zstd spawn error:', err.message));

  console.error('[sync] Piping tar -> zstd...');
  tar.stdout.pipe(zstd.stdin);
  console.error('[sync] Starting multipart upload...');

  const client = getS3Client(config);
  const key = `${config.prefix}${SNAPSHOT_KEY}`;
  console.error('[sync] Key:', key);

  // Start multipart upload
  console.error('[sync] Creating multipart upload...');
  const createResp = await client.send(new CreateMultipartUploadCommand({
    Bucket: config.bucket,
    Key: key,
    ContentType: 'application/zstd',
  }));
  const uploadId = createResp.UploadId;
  console.error('[sync] Multipart upload created, uploadId:', uploadId);

  const parts = [];
  const uploadPromises = [];
  let partNumber = 1;
  let currentBuffer = [];
  let currentSize = 0;
  let totalBytes = 0;
  let activeUploads = 0;
  let chunksReceived = 0;

  console.error('[sync] tar pid:', tar.pid, 'zstd pid:', zstd.pid);

  // Track early exits from tar/zstd
  let tarExited = false;
  let zstdExited = false;
  tar.on('exit', (code, signal) => {
    tarExited = true;
    console.error(`[sync] tar exited early: code=${code}, signal=${signal}`);
  });
  zstd.on('exit', (code, signal) => {
    zstdExited = true;
    console.error(`[sync] zstd exited early: code=${code}, signal=${signal}`);
  });

  // Upload a part with concurrency limiting
  const uploadPart = async (partNum, data) => {
    console.error(`[sync] Uploading part ${partNum}, size: ${(data.length / 1024 / 1024).toFixed(2)}MB`);
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
      console.error(`[sync] Part ${partNum} uploaded successfully`);
    } finally {
      activeUploads--;
    }
  };

  try {
    console.error('[sync] Entering streaming loop...');

    // Stream chunks and upload as parts when we hit 5MB
    // R2 requires all non-trailing parts to be EXACTLY the same size
    for await (const chunk of zstd.stdout) {
      chunksReceived++;
      if (chunksReceived === 1) {
        console.error('[sync] Received first chunk, size:', chunk.length);
      } else if (chunksReceived % 100 === 0) {
        console.error(`[sync] Received ${chunksReceived} chunks, ${(totalBytes / 1024 / 1024).toFixed(1)}MB so far`);
      }

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

        // Keep remainder for next iteration
        currentBuffer = remainder.length > 0 ? [remainder] : [];
        currentSize = remainder.length;
      }
    }

    // Wait for processes to finish
    console.error('[sync] Waiting for tar/zstd to finish...');
    await Promise.all([
      new Promise((resolve, reject) => {
        if (tarExited) return resolve(); // Already exited
        tar.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with ${code}`)));
        tar.on('error', reject);
      }),
      new Promise((resolve, reject) => {
        if (zstdExited) return resolve(); // Already exited
        zstd.on('close', (code) => code === 0 ? resolve() : reject(new Error(`zstd exited with ${code}`)));
        zstd.on('error', reject);
      }),
    ]);
    console.error('[sync] tar/zstd finished');

    // Wait for all in-flight uploads to complete
    console.error(`[sync] Waiting for ${uploadPromises.length} upload promises...`);
    await Promise.all(uploadPromises);
    console.error(`[sync] All uploads complete, ${parts.length} parts uploaded`);

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
      console.error(`[sync] Uploading final chunk: ${currentSize} bytes`);
      const partData = Buffer.concat(currentBuffer);
      await uploadPart(partNumber, partData);
      console.error('[sync] Final chunk uploaded');
    } else {
      console.error('[sync] No remaining data to upload');
    }

    // Sort parts by PartNumber (required for CompleteMultipartUpload)
    console.error(`[sync] Sorting ${parts.length} parts...`);
    parts.sort((a, b) => a.PartNumber - b.PartNumber);
    console.error('[sync] Parts sorted, completing multipart upload...');

    // Complete the multipart upload
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    }));
    console.error('[sync] CompleteMultipartUpload succeeded');

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const sizeMB = (totalBytes / 1024 / 1024).toFixed(1);
    console.error(`[sync] Upload complete (${sizeMB}MB, ${parts.length} parts) in ${elapsed}s`);
    return true;

  } catch (err) {
    // Abort the multipart upload on error
    console.error('[sync] Upload failed:', err.message);
    console.error('[sync] Error details:', JSON.stringify({
      name: err.name,
      code: err.code,
      $metadata: err.$metadata,
    }, null, 2));
    await client.send(new AbortMultipartUploadCommand({
      Bucket: config.bucket,
      Key: key,
      UploadId: uploadId,
    })).catch(() => {}); // Ignore abort errors
    tar.kill('SIGTERM');
    zstd.kill('SIGTERM');
    throw err;
  }
}

// CLI entry point
console.error('[sync] sync.mjs v5 starting');
const [,, command, dir] = process.argv;

if (!command || !dir) {
  console.error('Usage: node sync.mjs <download|upload> <directory>');
  process.exit(1);
}
console.error(`[sync] Command: ${command}, Directory: ${dir}`);

// Catch unhandled errors
process.on('uncaughtException', (err) => {
  console.error('[sync] Uncaught exception:', err.message);
  console.error('[sync] Stack:', err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[sync] Unhandled rejection at:', promise);
  console.error('[sync] Reason:', reason);
  process.exit(1);
});

// Ignore SIGPIPE (can happen if tar/zstd close unexpectedly)
process.on('SIGPIPE', () => {
  console.error('[sync] Received SIGPIPE, ignoring');
});

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
  console.error(`[sync] Stack: ${err.stack}`);
  process.exit(1);
}
