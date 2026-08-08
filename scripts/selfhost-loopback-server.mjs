#!/usr/bin/env node

import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Readable } from 'node:stream';
import { launchBrowser, Log, LogLevel } from 'miniflare';
import sharp from 'sharp';

const DEFAULT_BROWSER_VERSION = '126.0.6478.182';
const CUSTOM_FETCH_SERVICE_HEADER = 'mf-custom-fetch-service';
const ORIGINAL_URL_HEADER = 'mf-original-url';
const IMAGES_BINDING_SERVICE = 'MINIFLARE_IMAGES_BINDING_SERVICE';

/**
 * Minimal Miniflare loopback surface for local Browser Rendering and Images.
 * workerd forwards MINIFLARE_LOOPBACK fetches here via --external-addr=loopback=...
 */
export async function startSelfhostLoopbackServer(options = {}) {
  if (process.env.SELFHOST_BROWSER_NO_SANDBOX === '1') {
    process.env.CI = '1';
  }

  const hostname = options.hostname ?? '127.0.0.1';
  const tmpPath = options.tmpPath ?? path.join(os.tmpdir(), 'camelai-selfhost-loopback');
  const browserVersion = options.browserVersion
    ?? process.env.SELFHOST_BROWSER_VERSION
    ?? DEFAULT_BROWSER_VERSION;
  const log = options.log ?? new Log(LogLevel.WARN);
  const browserProcesses = new Map();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    try {
      if (req.headers[CUSTOM_FETCH_SERVICE_HEADER] === IMAGES_BINDING_SERVICE) {
        const response = await handleImagesBindingRequest(toWebRequest(req));
        await writeResponse(res, response);
        return;
      }

      if (url.pathname === '/browser/launch' && req.method === 'GET') {
        const headful = process.env.SELFHOST_BROWSER_HEADFUL === '1';
        const { sessionId, browserProcess, startTime, wsEndpoint } = await launchBrowser({
          browserVersion,
          headful,
          log,
          tmpPath,
        });
        browserProcess.nodeProcess.on('exit', () => {
          browserProcesses.delete(sessionId);
        });
        browserProcesses.set(sessionId, browserProcess);
        writeJson(res, 200, { wsEndpoint, sessionId, startTime });
        return;
      }

      if (url.pathname === '/browser/status' && req.method === 'GET') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          writeText(res, 400, 'Missing sessionId query parameter');
          return;
        }
        const browserProcess = browserProcesses.get(sessionId);
        res.writeHead(browserProcess ? 200 : 410);
        res.end();
        return;
      }

      if (url.pathname === '/browser/close' && req.method === 'POST') {
        const sessionId = url.searchParams.get('sessionId');
        if (!sessionId) {
          writeText(res, 400, 'Missing sessionId query parameter');
          return;
        }
        const browserProcess = browserProcesses.get(sessionId);
        if (!browserProcess) {
          writeText(res, 404, 'Session not found');
          return;
        }
        browserProcesses.delete(sessionId);
        await browserProcess.close().catch(() => {});
        res.writeHead(200);
        res.end();
        return;
      }

      if (url.pathname === '/browser/sessionIds' && req.method === 'GET') {
        writeJson(res, 200, Array.from(browserProcesses.keys()));
        return;
      }

      writeText(res, 404, 'Not found');
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error('[selfhost-loopback]', message);
      writeText(res, 500, message);
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, hostname, resolve);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to resolve self-host loopback listen port');
  }

  return {
    server,
    hostname,
    port: address.port,
    async close() {
      await Promise.all(
        [...browserProcesses.values()].map((browserProcess) => browserProcess.close().catch(() => {})),
      );
      browserProcesses.clear();
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export async function handleImagesBindingRequest(request) {
  const data = await request.formData();
  const image = data.get('image');
  if (!(image instanceof Blob)) {
    return imagesError(
      400,
      9523,
      `ERROR: Internal Images binding error: expected image in request, got ${image}`,
    );
  }

  const transformer = sharp(await image.arrayBuffer(), {});
  if (new URL(request.url).pathname === '/info') {
    return imageInfo(transformer);
  }

  const badTransformsResponse = imagesError(
    400,
    9523,
    'ERROR: Internal Images binding error: Expected JSON array of valid transforms in transforms field',
  );
  try {
    const transformsJson = data.get('transforms');
    if (typeof transformsJson !== 'string') return badTransformsResponse;
    const transforms = validateTransforms(JSON.parse(transformsJson));
    if (!transforms) return badTransformsResponse;
    const outputFormat = data.get('output_format');
    if (outputFormat !== null && typeof outputFormat !== 'string') {
      return imagesError(
        400,
        9523,
        'ERROR: Internal Images binding error: Expected output format to be a string if provided',
      );
    }
    return imageTransform(transformer, transforms, outputFormat);
  } catch {
    return badTransformsResponse;
  }
}

function validateTransforms(value) {
  if (!Array.isArray(value)) return null;
  for (const transform of value) {
    if (!transform || typeof transform !== 'object') return null;
    for (const key of ['imageIndex', 'rotate', 'width', 'height']) {
      if (transform[key] !== undefined && typeof transform[key] !== 'number') return null;
    }
  }
  return value;
}

async function imageInfo(transformer) {
  const metadata = await transformer.metadata();
  const format = {
    jpeg: 'image/jpeg',
    svg: 'image/svg+xml',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
    avif: 'image/avif',
  }[metadata.format];
  if (!format) {
    return imagesError(
      415,
      9520,
      `ERROR: Unsupported image type ${metadata.format}, expected one of: JPEG, SVG, PNG, WebP, GIF or AVIF`,
    );
  }
  if (format === 'image/svg+xml') return Response.json({ format });
  if (!metadata.size || !metadata.width || !metadata.height) {
    return imagesError(
      500,
      9523,
      'ERROR: Internal Images binding error: Expected size, width and height for bitmap input',
    );
  }
  return Response.json({
    format,
    fileSize: metadata.size,
    width: metadata.width,
    height: metadata.height,
  });
}

async function imageTransform(transformer, transforms, requestedFormat) {
  for (const transform of transforms) {
    if (transform.imageIndex !== undefined && transform.imageIndex !== 0) continue;
    if (transform.rotate !== undefined) transformer.rotate(transform.rotate);
    if (transform.width !== undefined || transform.height !== undefined) {
      transformer.resize(transform.width || null, transform.height || null, { fit: 'contain' });
    }
  }

  let outputFormat = requestedFormat;
  switch (outputFormat) {
    case 'image/avif':
      transformer.avif();
      break;
    case 'image/gif':
      return imagesError(415, 9520, 'ERROR: GIF output is not supported in local mode');
    case 'image/jpeg':
      transformer.jpeg();
      break;
    case 'image/png':
      transformer.png();
      break;
    case 'image/webp':
      transformer.webp();
      break;
    case 'rgb':
    case 'rgba':
      return imagesError(415, 9520, 'ERROR: RGB/RGBA output is not supported in local mode');
    default:
      outputFormat = 'image/jpeg';
      transformer.jpeg();
      break;
  }

  return new Response(await transformer.toBuffer(), {
    headers: { 'content-type': outputFormat },
  });
}

function imagesError(status, code, message) {
  return new Response(`ERROR ${code}: ${message}`, {
    status,
    headers: {
      'content-type': 'text/plain',
      'cf-images-binding': `err=${code}`,
    },
  });
}

function toWebRequest(req) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (['connection', 'host', 'transfer-encoding', CUSTOM_FETCH_SERVICE_HEADER].includes(name)) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (value !== undefined) {
      headers.append(name, value);
    }
  }
  const originalUrl = headers.get(ORIGINAL_URL_HEADER);
  headers.delete(ORIGINAL_URL_HEADER);
  const noBody = req.method === 'GET' || req.method === 'HEAD';
  return new Request(new URL(originalUrl ?? req.url ?? '/', 'http://localhost'), {
    method: req.method,
    headers,
    body: noBody ? undefined : Readable.toWeb(req),
    duplex: noBody ? undefined : 'half',
  });
}

async function writeResponse(res, response) {
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

function writeJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

function writeText(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(body);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const loopback = await startSelfhostLoopbackServer();
  console.log(`Self-host loopback listening on http://${loopback.hostname}:${loopback.port}`);
  const shutdown = async () => {
    await loopback.close().catch((error) => {
      console.error(error);
      process.exit(1);
    });
    process.exit(0);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      void shutdown();
    });
  }
}
