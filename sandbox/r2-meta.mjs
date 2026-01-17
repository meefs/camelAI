#!/usr/bin/env node
/**
 * Simple R2 helper for JuiceFS SQLite metadata.
 *
 * Usage:
 *   node r2-meta.mjs download <local-path>
 *   node r2-meta.mjs upload <local-path>
 *
 * Environment variables:
 *   R2_BUCKET_NAME, R2_ACCOUNT_ID, R2_PREFIX
 *   AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_SESSION_TOKEN (optional)
 */

import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { createReadStream, createWriteStream } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

const META_DB_FILENAME = 'juicefs-meta.db';
const META_JSON_FILENAME = 'juicefs-meta.json';
const META_STATE_SUFFIX = '.meta-state.json';

function normalizePrefix(prefix) {
  if (!prefix) return '';
  return prefix.endsWith('/') ? prefix : `${prefix}/`;
}

function getConfig() {
  const {
    R2_BUCKET_NAME,
    R2_ACCOUNT_ID,
    R2_PREFIX,
    AWS_ACCESS_KEY_ID,
    AWS_SECRET_ACCESS_KEY,
    AWS_SESSION_TOKEN,
  } = process.env;

  if (!R2_BUCKET_NAME || !R2_ACCOUNT_ID || !AWS_ACCESS_KEY_ID || !AWS_SECRET_ACCESS_KEY) {
    return null;
  }

  return {
    bucket: R2_BUCKET_NAME,
    prefix: normalizePrefix(R2_PREFIX),
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

function getMetaKey(config, localPath) {
  // Determine the R2 key based on the local file extension
  const isJson = localPath && localPath.endsWith('.json');
  const filename = isJson ? META_JSON_FILENAME : META_DB_FILENAME;
  return `${config.prefix}${filename}`;
}

async function download(localPath) {
  const config = getConfig();
  if (!config) {
    console.error('[r2-meta] No R2 credentials configured, skipping download');
    return false;
  }

  const client = getS3Client(config);
  const key = getMetaKey(config, localPath);

  try {
    await client.send(new HeadObjectCommand({ Bucket: config.bucket, Key: key }));
  } catch (err) {
    if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
      console.error(`[r2-meta] No metadata snapshot found at ${key}`);
      return false;
    }
    throw err;
  }

  await fs.mkdir(path.dirname(localPath), { recursive: true });
  const response = await client.send(new GetObjectCommand({ Bucket: config.bucket, Key: key }));
  await pipeline(response.Body, createWriteStream(localPath));
  console.error(`[r2-meta] Downloaded metadata snapshot from ${key}`);
  return true;
}

async function upload(localPath) {
  const config = getConfig();
  if (!config) {
    console.error('[r2-meta] No R2 credentials configured, skipping upload');
    return false;
  }

  let stat;
  try {
    stat = await fs.stat(localPath);
  } catch {
    console.error('[r2-meta] Metadata file not found, skipping upload');
    return false;
  }

  const statePath = `${localPath}${META_STATE_SUFFIX}`;
  try {
    const previous = JSON.parse(await fs.readFile(statePath, 'utf8'));
    if (previous?.size === stat.size && previous?.mtimeMs === stat.mtimeMs) {
      return false;
    }
  } catch {
    // No prior state.
  }

  const client = getS3Client(config);
  const key = getMetaKey(config, localPath);
  const isJson = localPath.endsWith('.json');
  const contentType = isJson ? 'application/json' : 'application/x-sqlite3';

  const stream = createReadStream(localPath);
  await client.send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: stream,
    ContentType: contentType,
  }));
  await fs.writeFile(statePath, JSON.stringify({ size: stat.size, mtimeMs: stat.mtimeMs }));
  console.error(`[r2-meta] Uploaded metadata snapshot to ${key}`);
  return true;
}

async function main() {
  const [, , command, localPath] = process.argv;
  if (!command || !localPath || !['download', 'upload'].includes(command)) {
    console.error('Usage: node r2-meta.mjs <download|upload> <local-path>');
    process.exit(1);
  }

  if (command === 'download') {
    await download(localPath);
    return;
  }

  await upload(localPath);
}

main().catch((err) => {
  console.error('[r2-meta] Fatal error:', err?.message || String(err));
  process.exit(1);
});
