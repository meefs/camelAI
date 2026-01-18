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
import os from 'os';

// Optimized for R2 parallel performance based on benchmarks:
// - Sweet spot: 48-64 parallel connections with 10-25MB chunks
// - Linear scaling up to ~32 connections, diminishing returns after
const PART_SIZE = 16 * 1024 * 1024; // 16MB parts (sweet spot for parallel transfers)
const MAX_CONCURRENT = 48; // Parallel connections for both upload and download

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

  // Check if snapshot exists and get size
  let fileSize;
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
    fileSize = head.ContentLength;
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.error('[sync] No snapshot found, starting fresh');
      return true;
    }
    throw err;
  }

  const sizeMB = (fileSize / 1024 / 1024).toFixed(1);
  console.error(`[sync] Downloading snapshot (${sizeMB}MB)...`);
  const startTime = Date.now();

  // Ensure target directory exists
  await fs.mkdir(targetDir, { recursive: true });

  // For small files (< 2 chunks), use simple sequential download
  if (fileSize < PART_SIZE * 2) {
    const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
    const tar = spawn('tar', ['--zstd', '-xf', '-', '-C', targetDir], { stdio: ['pipe', 'inherit', 'inherit'] });

    await Promise.all([
      pipeline(response.Body, tar.stdin),
      new Promise((resolve, reject) => {
        tar.on('close', (code) => {
          if (code === 0 || code === 1) return resolve();
          reject(new Error(`tar exited with ${code}`));
        });
        tar.on('error', reject);
      }),
    ]);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[sync] Download complete in ${elapsed}s`);
    return true;
  }

  // Parallel download using range requests
  // Download to temp file first, then extract (simpler than streaming reassembly)
  const tempFile = path.join(os.tmpdir(), `workspace-${Date.now()}.tar.zst`);

  try {
    // Calculate chunks
    const chunks = [];
    for (let start = 0; start < fileSize; start += PART_SIZE) {
      const end = Math.min(start + PART_SIZE - 1, fileSize - 1);
      chunks.push({ start, end, index: chunks.length });
    }

    const numChunks = chunks.length;
    console.error(`[sync] Downloading ${numChunks} chunks with ${MAX_CONCURRENT} parallel connections...`);

    // Pre-allocate the file
    const fd = await fs.open(tempFile, 'w');
    await fd.truncate(fileSize);
    await fd.close();

    // Download chunks in parallel with concurrency limit
    let completed = 0;
    let activeDownloads = 0;
    const errors = [];

    const downloadChunk = async (chunk) => {
      while (activeDownloads >= MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, 5));
      }
      activeDownloads++;

      try {
        const response = await client.send(new GetObjectCommand({
          Bucket: config.bucket,
          Key: key,
          Range: `bytes=${chunk.start}-${chunk.end}`,
        }));

        // Read the entire chunk into memory then write at correct offset
        const dataChunks = [];
        for await (const data of response.Body) {
          dataChunks.push(data);
        }
        const buffer = Buffer.concat(dataChunks);

        // Write at the correct offset
        const handle = await fs.open(tempFile, 'r+');
        await handle.write(buffer, 0, buffer.length, chunk.start);
        await handle.close();

        completed++;
        if (completed % 10 === 0 || completed === numChunks) {
          const pct = Math.round((completed / numChunks) * 100);
          console.error(`[sync] Download progress: ${pct}% (${completed}/${numChunks} chunks)`);
        }
      } catch (err) {
        errors.push({ chunk, error: err });
      } finally {
        activeDownloads--;
      }
    };

    // Start all downloads
    await Promise.all(chunks.map(chunk => downloadChunk(chunk)));

    if (errors.length > 0) {
      throw new Error(`Failed to download ${errors.length} chunks: ${errors[0].error.message}`);
    }

    const downloadElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const elapsedSecs = Math.max(0.1, (Date.now() - startTime) / 1000);
    const speed = (fileSize / 1024 / 1024 / elapsedSecs).toFixed(0);
    console.error(`[sync] Download finished in ${downloadElapsed}s (${speed}MB/s), extracting...`);

    // Extract from temp file
    const extractStart = Date.now();
    const tar = spawn('tar', ['--zstd', '-xf', tempFile, '-C', targetDir], { stdio: ['inherit', 'inherit', 'inherit'] });

    await new Promise((resolve, reject) => {
      tar.on('close', (code) => {
        if (code === 0 || code === 1) return resolve();
        reject(new Error(`tar exited with ${code}`));
      });
      tar.on('error', reject);
    });

    const extractElapsed = ((Date.now() - extractStart) / 1000).toFixed(1);
    const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    console.error(`[sync] Extract complete in ${extractElapsed}s (total: ${totalElapsed}s)`);

    return true;
  } finally {
    // Clean up temp file
    await fs.rm(tempFile, { force: true }).catch(() => {});
  }
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
  let completedParts = 0;
  let lastProgressLog = 0;

  // Track exit from tar
  let tarExited = false;
  tar.on('exit', () => { tarExited = true; });

  // Upload a part with concurrency limiting
  const uploadPart = async (partNum, data) => {
    while (activeUploads >= MAX_CONCURRENT) {
      await new Promise(r => setTimeout(r, 5));
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
      completedParts++;
      // Log progress every 10 parts or every 5 seconds
      const now = Date.now();
      if (completedParts % 10 === 0 || now - lastProgressLog > 5000) {
        const uploadedMB = (completedParts * PART_SIZE / 1024 / 1024).toFixed(0);
        console.error(`[sync] Upload progress: ${completedParts} parts (~${uploadedMB}MB)`);
        lastProgressLog = now;
      }
    } finally {
      activeUploads--;
    }
  };

  try {
    // Stream chunks and upload as parts when we hit PART_SIZE (16MB)
    // R2 requires all non-trailing parts to be EXACTLY the same size
    for await (const chunk of tar.stdout) {
      currentBuffer.push(chunk);
      currentSize += chunk.length;
      totalBytes += chunk.length;

      // Upload exactly PART_SIZE bytes, keep remainder for next part
      while (currentSize >= PART_SIZE) {
        const fullBuffer = Buffer.concat(currentBuffer);
        const partData = fullBuffer.subarray(0, PART_SIZE);
        const remainder = fullBuffer.subarray(PART_SIZE);

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

    // If we never uploaded any parts, data is < PART_SIZE - abort multipart and use simple upload
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
    const elapsedSecs = Math.max(0.1, (Date.now() - startTime) / 1000);
    const speed = (totalBytes / 1024 / 1024 / elapsedSecs).toFixed(0);
    console.error(`[sync] Upload complete (${sizeMB}MB, ${parts.length} parts) in ${elapsed}s (${speed}MB/s)`);
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
