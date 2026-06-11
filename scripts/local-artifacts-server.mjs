#!/usr/bin/env node
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const port = Number.parseInt(process.env.LOCAL_ARTIFACTS_PORT || "7001", 10);
const host = process.env.LOCAL_ARTIFACTS_HOST || "0.0.0.0";
const repoRoot = path.resolve(process.env.LOCAL_ARTIFACTS_REPO_ROOT || ".local-artifacts/repos");
const secret = process.env.LOCAL_ARTIFACTS_SECRET || "";
const publicBaseUrl = (process.env.LOCAL_ARTIFACTS_PUBLIC_BASE_URL || `http://localhost:${port}`).replace(/\/+$/, "");

if (!secret) {
  console.error("LOCAL_ARTIFACTS_SECRET is required");
  process.exit(1);
}

await mkdir(repoRoot, { recursive: true });

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || `localhost:${port}`}`);
    if (url.pathname === "/health") {
      sendJson(res, 200, { service: "local-artifacts", ok: true });
      return;
    }

    if (url.pathname === "/api/repos" && req.method === "POST") {
      requireManagementAuth(req);
      const body = await readJsonBody(req);
      const name = normalizeRepoName(body.name);
      const defaultBranch = normalizeBranch(body.defaultBranch);
      const repo = await ensureRepo(name, defaultBranch);
      sendJson(res, 200, repo);
      return;
    }

    const repoMatch = url.pathname.match(/^\/api\/repos\/([^/]+)(?:\/tokens)?$/);
    if (repoMatch) {
      requireManagementAuth(req);
      const name = normalizeRepoName(decodeURIComponent(repoMatch[1]));
      if (url.pathname.endsWith("/tokens") && req.method === "POST") {
        await assertRepoExists(name);
        const body = await readJsonBody(req);
        const scope = body.scope === "read" ? "read" : "write";
        const ttlSeconds = Math.max(60, Math.min(3600, Number(body.ttlSeconds) || 600));
        const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
        sendJson(res, 200, { token: signToken({ repo: name, scope, exp: Math.floor(Date.now() / 1000) + ttlSeconds }), expiresAt });
        return;
      }
      if (req.method === "GET") {
        await assertRepoExists(name);
        sendJson(res, 200, repoInfo(name));
        return;
      }
    }

    if (url.pathname.startsWith("/git/")) {
      await handleGit(req, res, url);
      return;
    }

    sendText(res, 404, "Not found");
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    sendText(res, status, error instanceof Error ? error.message : String(error));
  }
});

server.listen(port, host, () => {
  console.log(`[local-artifacts] listening on http://${host}:${port}, repos=${repoRoot}`);
});

function requireManagementAuth(req) {
  const header = req.headers["x-local-artifacts-secret"];
  const provided = Array.isArray(header) ? header[0] : header;
  if (!provided || provided !== secret) {
    throw new HttpError(403, "Forbidden");
  }
}

async function handleGit(req, res, url) {
  const match = url.pathname.match(/^\/git\/([^/]+\.git)(?:\/.*)?$/);
  if (!match) throw new HttpError(404, "Not found");

  const repo = normalizeRepoName(decodeURIComponent(match[1]).replace(/\.git$/, ""));
  await assertRepoExists(repo);
  const requiredScope = isReceivePack(url) ? "write" : "read";
  const token = parseBearer(req.headers.authorization);
  const claims = verifyToken(token);
  if (claims.repo !== repo || (requiredScope === "write" && claims.scope !== "write")) {
    throw new HttpError(403, "Forbidden");
  }

  const pathInfo = url.pathname.slice("/git".length);
  const child = spawn("git", ["http-backend"], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: repoRoot,
      GIT_HTTP_EXPORT_ALL: "1",
      PATH_INFO: pathInfo,
      QUERY_STRING: url.search.slice(1),
      REQUEST_METHOD: req.method || "GET",
      CONTENT_TYPE: headerValue(req.headers["content-type"]),
      CONTENT_LENGTH: headerValue(req.headers["content-length"]),
      HTTP_GIT_PROTOCOL: headerValue(req.headers["git-protocol"]),
      REMOTE_USER: "local-artifacts",
    },
  });

  req.pipe(child.stdin);
  const stdoutChunks = [];
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
  child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
  child.on("error", (error) => {
    if (!res.headersSent) sendText(res, 500, error.message);
  });
  child.on("exit", (code) => {
    const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
    if (code !== 0 && stderr) {
      console.error(`[local-artifacts] git http-backend exited ${code}: ${stderr}`);
    }
    writeCgiResponse(res, Buffer.concat(stdoutChunks));
  });
}

async function ensureRepo(name, defaultBranch) {
  const directory = repoDirectory(name);
  try {
    await stat(directory);
    return repoInfo(name);
  } catch {
    await mkdir(path.dirname(directory), { recursive: true });
  }
  await runGit(["init", "--bare", directory]);
  await runGit(["--git-dir", directory, "symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`]);
  await runGit(["--git-dir", directory, "config", "http.receivepack", "true"]);
  return repoInfo(name);
}

async function assertRepoExists(name) {
  const info = await stat(repoDirectory(name)).catch(() => null);
  if (!info?.isDirectory()) throw new HttpError(404, `Repo not found: ${name}`);
}

function repoInfo(name) {
  return {
    id: name,
    name,
    remote: `${publicBaseUrl}/git/${encodeURIComponent(name)}.git`,
    defaultBranch: "main",
    status: "ready",
  };
}

function repoDirectory(name) {
  return path.join(repoRoot, `${name}.git`);
}

function normalizeRepoName(value) {
  const raw = typeof value === "string" ? value.trim().replace(/\.git$/, "") : "";
  const normalized = raw.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 63);
  if (!normalized) throw new HttpError(400, "Repo name is required");
  return normalized;
}

function normalizeBranch(value) {
  return typeof value === "string" && /^[A-Za-z0-9._/-]+$/.test(value) ? value : "main";
}

function isReceivePack(url) {
  return url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
}

function parseBearer(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  const match = typeof raw === "string" ? raw.match(/^Bearer\s+(.+)$/i) : null;
  if (!match) throw new HttpError(403, "Forbidden");
  return match[1];
}

function headerValue(value) {
  if (Array.isArray(value)) return value[0] || "";
  return typeof value === "string" ? value : "";
}

function signToken(claims) {
  const payload = base64Url(JSON.stringify({ ...claims, nonce: randomBytes(8).toString("hex") }));
  const signature = hmac(payload);
  return `${payload}.${signature}`;
}

function verifyToken(token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature || !safeEqual(signature, hmac(payload))) throw new HttpError(403, "Forbidden");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!claims || typeof claims.repo !== "string" || !["read", "write"].includes(claims.scope)) {
    throw new HttpError(403, "Forbidden");
  }
  if (typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
    throw new HttpError(403, "Token expired");
  }
  return claims;
}

function hmac(payload) {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function writeCgiResponse(res, payload) {
  const split = findHeaderEnd(payload);
  if (!split) {
    sendText(res, 502, "Invalid git backend response");
    return;
  }
  const rawHeaders = payload.slice(0, split.headerEnd).toString("utf8");
  const body = payload.slice(split.bodyStart);
  let status = 200;
  for (const line of rawHeaders.split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf(":");
    if (index === -1) continue;
    const key = line.slice(0, index);
    const value = line.slice(index + 1).trim();
    if (key.toLowerCase() === "status") {
      status = Number.parseInt(value, 10) || status;
    } else {
      res.setHeader(key, value);
    }
  }
  res.statusCode = status;
  res.end(body);
}

function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { headerEnd: crlf, bodyStart: crlf + 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { headerEnd: lf, bodyStart: lf + 2 };
  return null;
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function sendText(res, status, body) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function runGit(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { stdio: ["ignore", "pipe", "pipe"] });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(" ")} failed: ${Buffer.concat(stderr).toString("utf8").trim()}`));
    });
  });
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
