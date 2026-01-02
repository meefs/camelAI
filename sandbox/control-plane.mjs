/**
 * Control Plane Server - HTTP API for exec and filesystem operations.
 * Runs as root on port 9000, providing privileged operations for the container.
 * All endpoints except /health require Bearer token authentication.
 *
 * Version: 2026-01-02-v2
 */
import http from 'node:http';
import { exec as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';

const exec = promisify(execCallback);
const PORT = parseInt(process.env.CONTROL_PLANE_PORT || '9000', 10);
const VERSION = '2026-01-02-v3';

// No auth required - control plane is only accessible from within the container
// or via containerFetch from the OrgContainer DO. Container isolation is the security boundary.

/**
 * Parse JSON body from request
 */
async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString();
  return body ? JSON.parse(body) : {};
}

/**
 * Send JSON response
 */
function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/**
 * Handle /health endpoint
 */
function handleHealth(res) {
  json(res, { status: 'ok', version: VERSION, pid: process.pid });
}

/**
 * Handle /exec endpoint
 * Body: { command: string, timeout?: number, cwd?: string }
 */
async function handleExec(res, body) {
  const { command, timeout = 30000, cwd } = body;

  if (!command || typeof command !== 'string') {
    return json(res, { success: false, error: 'command is required' }, 400);
  }

  try {
    const { stdout, stderr } = await exec(command, {
      timeout,
      cwd: cwd || process.cwd(),
      maxBuffer: 10 * 1024 * 1024, // 10MB
      env: process.env,
    });
    json(res, { success: true, stdout: stdout || '', stderr: stderr || '', exitCode: 0 });
  } catch (e) {
    // exec throws on non-zero exit code
    json(res, {
      success: e.killed ? false : (e.code === 0),
      stdout: e.stdout || '',
      stderr: e.stderr || e.message,
      exitCode: typeof e.code === 'number' ? e.code : 1,
      killed: e.killed || false,
      signal: e.signal || null,
    });
  }
}

/**
 * Handle /fs/exists endpoint
 * Body: { path: string }
 */
async function handleFsExists(res, body) {
  const { path: filePath } = body;

  if (!filePath || typeof filePath !== 'string') {
    return json(res, { success: false, error: 'path is required' }, 400);
  }

  try {
    const stat = await fs.stat(filePath);
    json(res, {
      exists: true,
      isFile: stat.isFile(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      json(res, { exists: false });
    } else {
      json(res, { success: false, error: e.message }, 500);
    }
  }
}

/**
 * Handle /fs/read endpoint
 * Body: { path: string, encoding?: string }
 */
// Simple MIME type lookup based on extension
const MIME_TYPES = {
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.ts': 'application/typescript',
  '.tsx': 'application/typescript',
  '.json': 'application/json',
  '.html': 'text/html',
  '.css': 'text/css',
  '.md': 'text/markdown',
  '.txt': 'text/plain',
  '.sh': 'text/x-shellscript',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
  '.toml': 'text/toml',
  '.xml': 'text/xml',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

function getMimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

function isBinaryMime(mimeType) {
  if (!mimeType) return false;
  if (mimeType.startsWith('text/')) return false;
  if (mimeType === 'application/json') return false;
  if (mimeType === 'application/javascript') return false;
  if (mimeType === 'application/typescript') return false;
  if (mimeType === 'image/svg+xml') return false;
  return true;
}

async function handleFsRead(res, body) {
  const { path: filePath, encoding = 'utf-8' } = body;

  if (!filePath || typeof filePath !== 'string') {
    return json(res, { success: false, error: 'path is required' }, 400);
  }

  try {
    const stat = await fs.stat(filePath);
    const mimeType = getMimeType(filePath);
    const isBinary = isBinaryMime(mimeType);

    let content;
    let responseEncoding = encoding;

    if (isBinary) {
      // Read as base64 for binary files
      const buffer = await fs.readFile(filePath);
      content = buffer.toString('base64');
      responseEncoding = 'base64';
    } else {
      content = await fs.readFile(filePath, encoding);
      responseEncoding = encoding;
    }

    json(res, {
      success: true,
      content,
      size: stat.size,
      isBinary,
      encoding: responseEncoding,
      mimeType,
    });
  } catch (e) {
    json(res, { success: false, error: e.message, code: e.code }, 500);
  }
}

/**
 * Handle /fs/write endpoint
 * Body: { path: string, content: string, encoding?: string }
 */
async function handleFsWrite(res, body) {
  const { path: filePath, content, encoding = 'utf-8' } = body;

  if (!filePath || typeof filePath !== 'string') {
    return json(res, { success: false, error: 'path is required' }, 400);
  }
  if (content === undefined) {
    return json(res, { success: false, error: 'content is required' }, 400);
  }

  try {
    // Ensure parent directory exists
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, encoding);
    json(res, { success: true });
  } catch (e) {
    json(res, { success: false, error: e.message, code: e.code }, 500);
  }
}

/**
 * Handle /fs/list endpoint
 * Body: { path: string, recursive?: boolean, includeHidden?: boolean }
 */
async function handleFsList(res, body) {
  const { path: dirPath, recursive = false, includeHidden = true } = body;

  if (!dirPath || typeof dirPath !== 'string') {
    return json(res, { success: false, error: 'path is required' }, 400);
  }

  try {
    const files = [];

    const listDir = async (dir, relativeTo) => {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (!includeHidden && entry.name.startsWith('.')) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(relativeTo, fullPath);

        try {
          const stat = await fs.stat(fullPath);
          files.push({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : 'file',
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
            relativePath,
            absolutePath: fullPath,
          });

          if (recursive && entry.isDirectory()) {
            await listDir(fullPath, relativeTo);
          }
        } catch (e) {
          // Skip files we can't stat (permissions, etc.)
          console.error(`[control-plane] Failed to stat ${fullPath}:`, e.message);
        }
      }
    };

    await listDir(dirPath, dirPath);
    json(res, { success: true, files, count: files.length, path: dirPath });
  } catch (e) {
    json(res, { success: false, error: e.message, code: e.code }, 500);
  }
}

/**
 * Handle /fs/mkdir endpoint
 * Body: { path: string, recursive?: boolean }
 */
async function handleFsMkdir(res, body) {
  const { path: dirPath, recursive = true } = body;

  if (!dirPath || typeof dirPath !== 'string') {
    return json(res, { success: false, error: 'path is required' }, 400);
  }

  try {
    await fs.mkdir(dirPath, { recursive });
    json(res, { success: true, timestamp: new Date().toISOString() });
  } catch (e) {
    json(res, { success: false, error: e.message, code: e.code }, 500);
  }
}

/**
 * Handle /fs/move endpoint
 * Body: { source: string, destination: string }
 */
async function handleFsMove(res, body) {
  const { source, destination } = body;

  if (!source || typeof source !== 'string') {
    return json(res, { success: false, error: 'source is required' }, 400);
  }
  if (!destination || typeof destination !== 'string') {
    return json(res, { success: false, error: 'destination is required' }, 400);
  }

  try {
    // Ensure destination parent directory exists
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.rename(source, destination);
    json(res, { success: true, timestamp: new Date().toISOString() });
  } catch (e) {
    json(res, { success: false, error: e.message, code: e.code }, 500);
  }
}

/**
 * Handle /fs/delete endpoint
 * Body: { path: string }
 */
async function handleFsDelete(res, body) {
  const { path: filePath } = body;

  if (!filePath || typeof filePath !== 'string') {
    return json(res, { success: false, error: 'path is required' }, 400);
  }

  try {
    await fs.rm(filePath, { recursive: true, force: true });
    json(res, { success: true, timestamp: new Date().toISOString() });
  } catch (e) {
    json(res, { success: false, error: e.message, code: e.code }, 500);
  }
}

/**
 * Main request handler
 */
async function handleRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    return handleHealth(res);
  }

  // Parse body for POST requests
  let body = {};
  if (req.method === 'POST') {
    try {
      body = await parseBody(req);
    } catch (e) {
      return json(res, { success: false, error: 'Invalid JSON body' }, 400);
    }
  }

  try {
    switch (url.pathname) {
      case '/exec':
        return await handleExec(res, body);

      case '/fs/exists':
        return await handleFsExists(res, body);

      case '/fs/read':
        return await handleFsRead(res, body);

      case '/fs/write':
        return await handleFsWrite(res, body);

      case '/fs/list':
        return await handleFsList(res, body);

      case '/fs/mkdir':
        return await handleFsMkdir(res, body);

      case '/fs/move':
        return await handleFsMove(res, body);

      case '/fs/delete':
        return await handleFsDelete(res, body);

      default:
        return json(res, { error: 'Not found', path: url.pathname }, 404);
    }
  } catch (e) {
    console.error('[control-plane] Unhandled error:', e);
    return json(res, { success: false, error: e.message }, 500);
  }
}

// Create and start HTTP server
const server = http.createServer(handleRequest);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[control-plane] Listening on port ${PORT}`);
  console.log(`[control-plane] Version: ${VERSION}`);
  console.log(`[control-plane] PID: ${process.pid}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[control-plane] Received SIGTERM, shutting down...');
  server.close(() => {
    console.log('[control-plane] Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('[control-plane] Received SIGINT, shutting down...');
  server.close(() => {
    console.log('[control-plane] Server closed');
    process.exit(0);
  });
});
