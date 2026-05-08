import {
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";

type ExecResponse = {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  error?: string;
};

const proxyEnvKeys = [
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_BASE_URL",
  "CLOUDFLARE_API_TOKEN",
  "CAMELAI_CONNECTIONS_URL",
  "DATA_PROXY_URL",
  "MCP_SERVER_URL",
  "ORG_ID",
  "RESEND_PROXY_URL",
  "THREAD_ID",
  "WORKSPACE_ID",
];

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

[
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "ORG_ID",
  "THREAD_ID",
  "WORKSPACE_ID",
  "CHIRIDION_CONTAINER_EXEC_URL",
  "CHIRIDION_CONTAINER_PROXY_BASE_URL",
  "CHIRIDION_HOST_MCP_SERVER_URL",
].forEach(requireEnv);

const hostCwd = process.env.CHIRIDION_PI_WORKSPACE_CWD || process.cwd();
const containerCwd = process.env.CHIRIDION_PI_CONTAINER_CWD || "/home/claude";
const execUrl = requireEnv("CHIRIDION_CONTAINER_EXEC_URL");
const askUserQuestionUrl = process.env.CHIRIDION_ASK_USER_QUESTION_URL || "";
const askUserQuestionToken = process.env.CHIRIDION_ASK_USER_QUESTION_TOKEN || "";
const todoStateUrl = process.env.CHIRIDION_TODO_STATE_URL || "";
const webSearchUrl = process.env.CHIRIDION_WEB_SEARCH_URL || "";
const webFetchUrl = process.env.CHIRIDION_WEB_FETCH_URL || "";
const mcpServerUrl = requireEnv("CHIRIDION_HOST_MCP_SERVER_URL").replace(/\/+$/, "");
const hostPiToken = process.env.CHIRIDION_HOST_PI_TOKEN || askUserQuestionToken;
const threadId = requireEnv("THREAD_ID");
const containerProxyBase = requireEnv("CHIRIDION_CONTAINER_PROXY_BASE_URL").replace(/\/+$/, "");
const allowedContainerRoots = [containerCwd, "/mnt/user-uploads", "/mnt/user-outputs"];
const hostPiSkillsPath = process.env.CHIRIDION_HOST_PI_SKILLS_PATH || process.env.HOST_PI_SKILLS_PATH || "";
const containerPiSkillsPath = process.env.CHIRIDION_CONTAINER_PI_SKILLS_PATH || "/opt/chiridion-host-pi/skills";
const isSubagentProcess = process.env.CHIRIDION_PI_SUBAGENT === "1";
const isReadOnlySubagent = process.env.CHIRIDION_PI_READ_ONLY === "1";

function toContainerCwd(cwd?: string): string {
  if (!cwd) return containerCwd;
  if (cwd === hostCwd) return containerCwd;
  if (cwd.startsWith(`${hostCwd}/`)) {
    return `${containerCwd}/${cwd.slice(hostCwd.length + 1)}`;
  }
  if (cwd.startsWith(containerCwd)) return cwd;
  if (cwd.startsWith("/mnt/user-uploads") || cwd.startsWith("/mnt/user-outputs")) return cwd;
  if (!path.isAbsolute(cwd)) return toContainerPath(cwd);
  return containerCwd;
}

function toContainerPath(path: string): string {
  let candidate = path;
  if (candidate === hostCwd) candidate = containerCwd;
  if (candidate.startsWith(`${hostCwd}/`)) {
    candidate = `${containerCwd}/${candidate.slice(hostCwd.length + 1)}`;
  }
  const resolved = pathModuleResolve(candidate);
  if (allowedContainerRoots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    return resolved;
  }
  throw new Error("path must stay within the workspace or mounted user file directories");
}

function toReadableContainerPath(pathValue: string): string {
  const mirroredSkillPath = toContainerSkillPath(pathValue);
  if (mirroredSkillPath) return mirroredSkillPath;

  const resolved = pathModuleResolve(pathValue);
  const roots = [...allowedContainerRoots, normalizedContainerSkillsPath()].filter(Boolean);
  if (roots.some((root) => resolved === root || resolved.startsWith(`${root}/`))) {
    return resolved;
  }
  return toContainerPath(pathValue);
}

function normalizedContainerSkillsPath(): string {
  return containerPiSkillsPath.trim() ? path.resolve(containerPiSkillsPath) : "";
}

function toContainerSkillPath(pathValue: unknown): string | undefined {
  if (typeof pathValue !== "string" || !pathValue.trim()) return undefined;
  const containerRoot = normalizedContainerSkillsPath();
  if (!containerRoot) return undefined;

  const resolvedInput = path.resolve(pathValue);
  if (resolvedInput === containerRoot || resolvedInput.startsWith(`${containerRoot}${path.sep}`)) {
    return resolvedInput;
  }

  if (!hostPiSkillsPath.trim()) return undefined;
  const hostRoot = path.resolve(hostPiSkillsPath);
  if (resolvedInput !== hostRoot && !resolvedInput.startsWith(`${hostRoot}${path.sep}`)) {
    return undefined;
  }
  const relativePath = path.relative(hostRoot, resolvedInput);
  return path.resolve(containerRoot, relativePath);
}

function pathModuleResolve(candidate: string): string {
  return path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(containerCwd, candidate);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runContainerCommand(
  command: string,
  cwd?: string,
  signal?: AbortSignal,
  extraEnv?: Record<string, string | undefined>,
): Promise<ExecResponse> {
  if (!execUrl) {
    throw new Error("CHIRIDION_CONTAINER_EXEC_URL is not configured");
  }
  const env = Object.fromEntries(
    proxyEnvKeys
      .map((key) => [key, process.env[key]])
      .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length > 0),
  );
  if (containerProxyBase) {
    env.CLOUDFLARE_API_BASE_URL = `${containerProxyBase}/client/v4`;
    env.CAMELAI_CONNECTIONS_URL = `${containerProxyBase}/api/connections`;
    env.DATA_PROXY_URL = `${containerProxyBase}/api`;
    env.MCP_SERVER_URL = `${containerProxyBase}/mcp`;
    env.RESEND_PROXY_URL = `${containerProxyBase}/api/resend`;
  }
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    if (typeof value === "string" && value.length > 0 && proxyEnvKeys.includes(key)) {
      env[key] = value;
    }
  }
  const response = await fetch(execUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cmd: ["bash", "-lc", command],
      cwd: toContainerCwd(cwd),
      env,
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as ExecResponse;
  if (!response.ok) {
    throw new Error(payload.error || `Container exec failed with HTTP ${response.status}`);
  }
  return payload;
}

async function runContainerNode<T extends Record<string, unknown>>(
  payload: T,
  script: string,
  signal?: AbortSignal,
): Promise<ExecResponse> {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return runContainerCommand(
    `PAYLOAD_B64=${shellQuote(encodedPayload)} node <<'NODE'\n${CONTAINER_NODE_PREAMBLE}\n${script}\nNODE`,
    containerCwd,
    signal,
  );
}

async function runReadOnlyContainerNode<T extends Record<string, unknown>>(
  payload: T,
  script: string,
  signal?: AbortSignal,
): Promise<ExecResponse> {
  const extraAllowedRoots = [normalizedContainerSkillsPath()].filter(Boolean);
  return runContainerNode({ ...payload, allowedRoots: extraAllowedRoots }, script, signal);
}

function assertExecSuccess(result: ExecResponse): void {
  if (result.success === false || (typeof result.exitCode === "number" && result.exitCode !== 0)) {
    throw new Error([result.stderr, result.stdout, result.error].filter(Boolean).join("\n") || "Container command failed");
  }
}

function truncateText(value: unknown, maxCharacters = 16000): string {
  const text = String(value ?? "");
  if (text.length <= maxCharacters) return text;
  return `${text.slice(0, maxCharacters)}\n\n[Truncated: ${maxCharacters} of ${text.length} characters]`;
}

const CONTAINER_NODE_PREAMBLE = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");
const payload = JSON.parse(Buffer.from(process.env.PAYLOAD_B64 || "", "base64").toString("utf8"));
const workspaceRoot = "/home/claude";
const extraAllowedRoots = Array.isArray(payload.allowedRoots) ? payload.allowedRoots.filter((root) => typeof root === "string" && root.trim()) : [];
const allowedRoots = [workspaceRoot, "/mnt/user-uploads", "/mnt/user-outputs", ...extraAllowedRoots].map((root) => path.resolve(root));
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;
const GREP_MAX_LINE_LENGTH = 500;

function resolveWorkspacePath(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("path is required");
  const raw = input.trim();
  const resolved = path.resolve(workspaceRoot, raw);
  for (const root of allowedRoots) {
    if (resolved === root || resolved.startsWith(root + path.sep)) return resolved;
  }
  throw new Error("path must stay within the workspace or mounted user file directories");
}

function truncate(value, maxBytes = 51200) {
  const text = String(value ?? "");
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes <= maxBytes) return text;
  let out = "";
  let used = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > maxBytes) break;
    out += char;
    used += size;
  }
  return out + "\n\n[Output truncated: " + used + " of " + bytes + " bytes]";
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + "B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + "KB";
  return (bytes / (1024 * 1024)).toFixed(1) + "MB";
}

function truncateHead(content, options = {}) {
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const totalBytes = Buffer.byteLength(content, "utf8");
  const lines = String(content ?? "").split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, totalBytes, outputLines: totalLines, outputBytes: totalBytes, lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes };
  }
  const firstLineBytes = Buffer.byteLength(lines[0] || "", "utf8");
  if (firstLineBytes > maxBytes) {
    return { content: "", truncated: true, truncatedBy: "bytes", totalLines, totalBytes, outputLines: 0, outputBytes: 0, lastLinePartial: false, firstLineExceedsLimit: true, maxLines, maxBytes };
  }
  const outputLinesArr = [];
  let outputBytesCount = 0;
  let truncatedBy = "lines";
  for (let i = 0; i < lines.length && i < maxLines; i++) {
    const line = lines[i];
    const lineBytes = Buffer.byteLength(line, "utf8") + (i > 0 ? 1 : 0);
    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      break;
    }
    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }
  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) truncatedBy = "lines";
  const outputContent = outputLinesArr.join("\n");
  return { content: outputContent, truncated: true, truncatedBy, totalLines, totalBytes, outputLines: outputLinesArr.length, outputBytes: Buffer.byteLength(outputContent, "utf8"), lastLinePartial: false, firstLineExceedsLimit: false, maxLines, maxBytes };
}

function truncateLine(line, maxChars = GREP_MAX_LINE_LENGTH) {
  if (line.length <= maxChars) return { text: line, wasTruncated: false };
  return { text: line.slice(0, maxChars) + "... [truncated]", wasTruncated: true };
}

function toolResult(text, details) {
  const out = { content: [{ type: "text", text }] };
  if (details && Object.keys(details).length > 0) out.details = details;
  return out;
}

function commandExists(name) {
  const result = childProcess.spawnSync("bash", ["-lc", "command -v " + name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim().split("\n")[0] : "";
}
`;

const editAccessScript = String.raw`
const filePath = resolveWorkspacePath(payload.path);
fs.accessSync(filePath, fs.constants.R_OK | fs.constants.W_OK);
`;

const readAccessScript = String.raw`
const filePath = resolveWorkspacePath(payload.path);
fs.accessSync(filePath, fs.constants.R_OK);
`;

const editReadScript = String.raw`
const filePath = resolveWorkspacePath(payload.path);
process.stdout.write(fs.readFileSync(filePath).toString("base64"));
`;

const editWriteScript = String.raw`
const filePath = resolveWorkspacePath(payload.path);
fs.writeFileSync(filePath, String(payload.content ?? ""), "utf8");
`;

const mkdirScript = String.raw`
const dirPath = resolveWorkspacePath(payload.path);
fs.mkdirSync(dirPath, { recursive: true });
`;

const detectImageMimeTypeScript = String.raw`
const filePath = resolveWorkspacePath(payload.path);
const buffer = fs.readFileSync(filePath, { flag: "r" }).subarray(0, 4100);
let mimeType = null;
if (buffer.length >= 8 && buffer[0] === 0x89 && buffer.toString("ascii", 1, 4) === "PNG") {
  mimeType = "image/png";
} else if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
  mimeType = "image/jpeg";
} else if (buffer.length >= 6 && (buffer.toString("ascii", 0, 6) === "GIF87a" || buffer.toString("ascii", 0, 6) === "GIF89a")) {
  mimeType = "image/gif";
} else if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
  mimeType = "image/webp";
}
process.stdout.write(mimeType || "");
`;

const builtinLikeLsScript = String.raw`
const dirPath = resolveWorkspacePath(payload.path || ".");
if (!fs.existsSync(dirPath)) throw new Error("Path not found: " + dirPath);
const dirStat = fs.statSync(dirPath);
if (!dirStat.isDirectory()) throw new Error("Not a directory: " + dirPath);
const effectiveLimit = Math.max(1, Number(payload.limit || 500));
const entries = fs.readdirSync(dirPath).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
const results = [];
let entryLimitReached = false;
for (const entry of entries) {
  if (results.length >= effectiveLimit) {
    entryLimitReached = true;
    break;
  }
  try {
    const entryStat = fs.statSync(path.join(dirPath, entry));
    results.push(entry + (entryStat.isDirectory() ? "/" : ""));
  } catch {
    // Match builtin behavior: skip entries we cannot stat.
  }
}
if (results.length === 0) {
  process.stdout.write(JSON.stringify(toolResult("(empty directory)")));
} else {
  const rawOutput = results.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const details = {};
  const notices = [];
  let output = truncation.content;
  if (entryLimitReached) {
    notices.push(effectiveLimit + " entries limit reached. Use limit=" + (effectiveLimit * 2) + " for more");
    details.entryLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(formatSize(DEFAULT_MAX_BYTES) + " limit reached");
    details.truncation = truncation;
  }
  if (notices.length > 0) output += "\n\n[" + notices.join(". ") + "]";
  process.stdout.write(JSON.stringify(toolResult(output, details)));
}
`;

const builtinLikeGrepScript = String.raw`
const searchPath = resolveWorkspacePath(payload.path || ".");
let isDirectory = false;
try {
  isDirectory = fs.statSync(searchPath).isDirectory();
} catch {
  throw new Error("Path not found: " + searchPath);
}
const rgPath = commandExists("rg");
if (!rgPath) throw new Error("ripgrep (rg) is not available");
const contextValue = payload.context && Number(payload.context) > 0 ? Number(payload.context) : 0;
const effectiveLimit = Math.max(1, Number(payload.limit || 100));
const args = ["--json", "--line-number", "--color=never", "--hidden"];
if (payload.ignoreCase) args.push("--ignore-case");
if (payload.literal) args.push("--fixed-strings");
if (typeof payload.glob === "string" && payload.glob.trim()) args.push("--glob", payload.glob);
args.push("--", String(payload.pattern ?? ""), searchPath);
const result = childProcess.spawnSync(rgPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0 && result.status !== 1) throw new Error((result.stderr || "").trim() || "ripgrep exited with code " + result.status);
const formatPath = (filePath) => {
  if (isDirectory) {
    const relative = path.relative(searchPath, filePath);
    if (relative && !relative.startsWith("..")) return relative.split(path.sep).join("/");
  }
  return path.basename(filePath);
};
const fileCache = new Map();
const getFileLines = (filePath) => {
  if (!fileCache.has(filePath)) {
    try {
      fileCache.set(filePath, fs.readFileSync(filePath, "utf8").replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n"));
    } catch {
      fileCache.set(filePath, []);
    }
  }
  return fileCache.get(filePath);
};
const matches = [];
let matchLimitReached = false;
for (const line of String(result.stdout || "").split("\n")) {
  if (!line.trim()) continue;
  let event;
  try { event = JSON.parse(line); } catch { continue; }
  if (event.type !== "match") continue;
  if (matches.length >= effectiveLimit) {
    matchLimitReached = true;
    break;
  }
  const filePath = event.data?.path?.text;
  const lineNumber = event.data?.line_number;
  const lineText = event.data?.lines?.text;
  if (filePath && typeof lineNumber === "number") matches.push({ filePath, lineNumber, lineText });
  if (matches.length >= effectiveLimit) matchLimitReached = true;
}
if (matches.length === 0) {
  process.stdout.write(JSON.stringify(toolResult("No matches found")));
} else {
  const outputLines = [];
  let linesTruncated = false;
  for (const match of matches) {
    const relativePath = formatPath(match.filePath);
    if (contextValue === 0 && match.lineText !== undefined) {
      const sanitized = String(match.lineText).replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, "");
      const truncated = truncateLine(sanitized);
      if (truncated.wasTruncated) linesTruncated = true;
      outputLines.push(relativePath + ":" + match.lineNumber + ": " + truncated.text);
    } else {
      const lines = getFileLines(match.filePath);
      if (!lines.length) {
        outputLines.push(relativePath + ":" + match.lineNumber + ": (unable to read file)");
        continue;
      }
      const start = contextValue > 0 ? Math.max(1, match.lineNumber - contextValue) : match.lineNumber;
      const end = contextValue > 0 ? Math.min(lines.length, match.lineNumber + contextValue) : match.lineNumber;
      for (let current = start; current <= end; current++) {
        const truncated = truncateLine(String(lines[current - 1] || "").replace(/\r/g, ""));
        if (truncated.wasTruncated) linesTruncated = true;
        outputLines.push(relativePath + (current === match.lineNumber ? ":" : "-") + current + (current === match.lineNumber ? ": " : "- ") + truncated.text);
      }
    }
  }
  const rawOutput = outputLines.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const details = {};
  const notices = [];
  let output = truncation.content;
  if (matchLimitReached) {
    notices.push(effectiveLimit + " matches limit reached. Use limit=" + (effectiveLimit * 2) + " for more, or refine pattern");
    details.matchLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(formatSize(DEFAULT_MAX_BYTES) + " limit reached");
    details.truncation = truncation;
  }
  if (linesTruncated) {
    notices.push("Some lines truncated to " + GREP_MAX_LINE_LENGTH + " chars. Use read tool to see full lines");
    details.linesTruncated = true;
  }
  if (notices.length > 0) output += "\n\n[" + notices.join(". ") + "]";
  process.stdout.write(JSON.stringify(toolResult(output, details)));
}
`;

const builtinLikeFindScript = String.raw`
const searchPath = resolveWorkspacePath(payload.path || ".");
if (!fs.existsSync(searchPath)) throw new Error("Path not found: " + searchPath);
const fdPath = commandExists("fd") || commandExists("fdfind");
if (!fdPath) throw new Error("fd is not available");
const effectiveLimit = Math.max(1, Number(payload.limit || 1000));
const args = ["--glob", "--color=never", "--hidden", "--no-require-git", "--max-results", String(effectiveLimit)];
let effectivePattern = String(payload.pattern ?? "");
if (effectivePattern.includes("/")) {
  args.push("--full-path");
  if (!effectivePattern.startsWith("/") && !effectivePattern.startsWith("**/") && effectivePattern !== "**") {
    effectivePattern = "**/" + effectivePattern;
  }
}
args.push("--", effectivePattern, searchPath);
const result = childProcess.spawnSync(fdPath, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
if (result.error) throw result.error;
if (result.status !== 0 && !String(result.stdout || "").trim()) throw new Error((result.stderr || "").trim() || "fd exited with code " + result.status);
const relativized = [];
for (const rawLine of String(result.stdout || "").split("\n")) {
  const line = rawLine.replace(/\r$/, "").trim();
  if (!line) continue;
  const hadTrailingSlash = line.endsWith("/") || line.endsWith("\\");
  let relativePath = line;
  if (line.startsWith(searchPath)) {
    relativePath = line.slice(searchPath.length + 1);
  } else {
    relativePath = path.relative(searchPath, line);
  }
  if (hadTrailingSlash && !relativePath.endsWith("/")) relativePath += "/";
  relativized.push(relativePath.split(path.sep).join("/"));
}
if (relativized.length === 0) {
  process.stdout.write(JSON.stringify(toolResult("No files found matching pattern")));
} else {
  const resultLimitReached = relativized.length >= effectiveLimit;
  const rawOutput = relativized.join("\n");
  const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
  const details = {};
  const notices = [];
  let output = truncation.content;
  if (resultLimitReached) {
    notices.push(effectiveLimit + " results limit reached. Use limit=" + (effectiveLimit * 2) + " for more, or refine pattern");
    details.resultLimitReached = effectiveLimit;
  }
  if (truncation.truncated) {
    notices.push(formatSize(DEFAULT_MAX_BYTES) + " limit reached");
    details.truncation = truncation;
  }
  if (notices.length > 0) output += "\n\n[" + notices.join(". ") + "]";
  process.stdout.write(JSON.stringify(toolResult(output, details)));
}
`;

async function runReadOnlyJsonTool<T = unknown>(
  payload: Record<string, unknown>,
  script: string,
  signal?: AbortSignal,
): Promise<T> {
  const result = await runReadOnlyContainerNode(payload, script, signal);
  assertExecSuccess(result);
  try {
    return JSON.parse(result.stdout || "null") as T;
  } catch (error) {
    throw new Error(`Container tool returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const containerEditOperations: EditOperations = {
  async access(absolutePath: string): Promise<void> {
    const result = await runContainerNode({ path: toContainerPath(absolutePath) }, editAccessScript);
    assertExecSuccess(result);
  },
  async readFile(absolutePath: string): Promise<Buffer> {
    const result = await runContainerNode({ path: toContainerPath(absolutePath) }, editReadScript);
    assertExecSuccess(result);
    return Buffer.from(result.stdout || "", "base64");
  },
  async writeFile(absolutePath: string, content: string): Promise<void> {
    const result = await runContainerNode({ path: toContainerPath(absolutePath), content }, editWriteScript);
    assertExecSuccess(result);
  },
};

const containerReadOperations: ReadOperations = {
  async access(absolutePath: string): Promise<void> {
    const result = await runReadOnlyContainerNode({ path: toReadableContainerPath(absolutePath) }, readAccessScript);
    assertExecSuccess(result);
  },
  async readFile(absolutePath: string): Promise<Buffer> {
    const result = await runReadOnlyContainerNode({ path: toReadableContainerPath(absolutePath) }, editReadScript);
    assertExecSuccess(result);
    return Buffer.from(result.stdout || "", "base64");
  },
  async detectImageMimeType(absolutePath: string): Promise<string | null | undefined> {
    const result = await runReadOnlyContainerNode({ path: toReadableContainerPath(absolutePath) }, detectImageMimeTypeScript);
    assertExecSuccess(result);
    return result.stdout?.trim() || null;
  },
};

const containerWriteOperations: WriteOperations = {
  async mkdir(absolutePath: string): Promise<void> {
    const result = await runContainerNode({ path: toContainerPath(absolutePath) }, mkdirScript);
    assertExecSuccess(result);
  },
  async writeFile(absolutePath: string, content: string): Promise<void> {
    const result = await runContainerNode({ path: toContainerPath(absolutePath), content }, editWriteScript);
    assertExecSuccess(result);
  },
};

function combinedAbortSignal(source?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  if (!source) return { signal: controller.signal, dispose: () => {} };
  if (source.aborted) {
    controller.abort(source.reason);
    return { signal: controller.signal, dispose: () => {} };
  }
  const onAbort = () => controller.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    dispose: () => source.removeEventListener("abort", onAbort),
  };
}

const containerBashOperations: BashOperations = {
  async exec(command, cwd, options) {
    const { signal, dispose } = combinedAbortSignal(options.signal);
    let timedOut = false;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutController = new AbortController();
    const abortTimeout = () => timeoutController.abort();
    const onCombinedAbort = () => timeoutController.abort();
    if (signal.aborted) timeoutController.abort();
    else signal.addEventListener("abort", onCombinedAbort, { once: true });
    if (options.timeout !== undefined && options.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        abortTimeout();
      }, options.timeout * 1000);
    }
    try {
      const result = await runContainerCommand(command, cwd, timeoutController.signal, options.env);
      const output = [result.stdout || "", result.stderr || ""].filter(Boolean).join("\n");
      if (output) options.onData(Buffer.from(output, "utf8"));
      return { exitCode: typeof result.exitCode === "number" ? result.exitCode : result.success === false ? 1 : 0 };
    } catch (error) {
      if (timedOut) throw new Error(`timeout:${options.timeout}`);
      if (options.signal?.aborted) throw new Error("aborted");
      throw error;
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal.removeEventListener("abort", onCombinedAbort);
      dispose();
    }
  },
};

const askUserQuestionParameters = Type.Object({
  questions: Type.Array(
    Type.Object({
      question: Type.String({ description: "The question to ask the user." }),
      header: Type.Optional(Type.String({ description: "Short label shown above the question." })),
      options: Type.Array(
        Type.Object({
          label: Type.String({ description: "Option label shown to the user." }),
          description: Type.Optional(Type.String({ description: "Short explanation for the option." })),
        }),
        { minItems: 2, maxItems: 10, description: "Multiple-choice options for the question." },
      ),
      multiSelect: Type.Optional(Type.Boolean({ description: "Allow selecting multiple options when true." })),
    }),
    { minItems: 1, maxItems: 4, description: "One to four questions to ask in a single flow." },
  ),
});

const todoWriteParameters = Type.Object({
  todos: Type.Array(
    Type.Object({
      content: Type.String({ description: "Short task description in the user's language." }),
      activeForm: Type.Optional(Type.String({ description: "Present-tense form shown while this task is in progress." })),
      status: Type.Union(
        [Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed")],
        { description: "Current task status." },
      ),
    }),
    {
      minItems: 0,
      maxItems: 50,
      description: "The full current task list. Include all tasks each time this tool is called.",
    },
  ),
});

const webSearchParameters = Type.Object({
  query: Type.String({ description: "Natural language search query." }),
  numResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Number of results to return. Defaults to 5." })),
  searchType: Type.Optional(Type.Union([
    Type.Literal("auto"),
    Type.Literal("fast"),
    Type.Literal("neural"),
    Type.Literal("deep"),
  ], { description: "Search strategy hint. Defaults to auto; unsupported providers may ignore it." })),
  maxCharacters: Type.Optional(Type.Integer({ minimum: 200, maximum: 8000, description: "Max snippet characters per result. Search never fetches full page content." })),
  includeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Only include these domains." })),
  excludeDomains: Type.Optional(Type.Array(Type.String(), { maxItems: 20, description: "Exclude these domains." })),
  startPublishedDate: Type.Optional(Type.String({ description: "ISO 8601 lower bound for published date." })),
  endPublishedDate: Type.Optional(Type.String({ description: "ISO 8601 upper bound for published date." })),
  category: Type.Optional(Type.Union([
    Type.Literal("company"),
    Type.Literal("people"),
    Type.Literal("research paper"),
    Type.Literal("news"),
    Type.Literal("pdf"),
    Type.Literal("github"),
    Type.Literal("tweet"),
    Type.Literal("personal site"),
    Type.Literal("financial report"),
  ], { description: "Optional category filter. Unsupported providers may ignore it." })),
});

const webFetchParameters = Type.Object({
  url: Type.String({ description: "URL to fetch." }),
  query: Type.Optional(Type.String({ description: "Optional focus query for highlights." })),
  content: Type.Optional(Type.Union([
    Type.Literal("text"),
    Type.Literal("highlights"),
    Type.Literal("summary"),
  ], { description: "Content mode. Defaults to text." })),
  maxCharacters: Type.Optional(Type.Integer({ minimum: 500, maximum: 30000, description: "Maximum characters to return. Defaults to 12000." })),
  fresh: Type.Optional(Type.Boolean({ description: "Force live crawling instead of cached content." })),
});

const exploreParameters = Type.Object({
  prompt: Type.String({
    description: "The specific investigation to delegate. Ask for concrete file paths, findings, and evidence.",
  }),
  context: Type.Optional(Type.String({ description: "Optional extra context to give the explore subagent." })),
  model: Type.Optional(Type.String({ description: "Optional model override. Defaults to Haiku for Claude sessions and gpt-5.4-mini otherwise." })),
  maxMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum runtime in minutes. Defaults to 3." })),
});

const agentParameters = Type.Object({
  prompt: Type.String({ description: "Task to delegate to a separate Pi agent with an isolated context window." }),
  agentType: Type.Optional(Type.Union([
    Type.Literal("explore"),
    Type.Literal("general"),
  ], { description: "Subagent behavior. Defaults to general." })),
  context: Type.Optional(Type.String({ description: "Optional extra context to include with the task." })),
  model: Type.Optional(Type.String({ description: "Optional model override. Defaults to a weaker model for explore tasks." })),
  readOnly: Type.Optional(Type.Boolean({ description: "When true, only read/search/fetch tools are exposed to the subagent. Defaults to true for explore, false for general." })),
  maxMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum runtime in minutes. Defaults to 5." })),
});

const emptyParameters = Type.Object({});

const mcpToolDefinitions = [
  {
    name: "list_apps",
    label: "List Apps",
    description:
      "List deployed apps/workers for the current workspace. Returns script names, URLs, visibility status, and creation info.",
    parameters: emptyParameters,
  },
  {
    name: "set_app_visibility",
    label: "Set App Visibility",
    description:
      "Change the visibility of a deployed app in the current workspace. Public apps are accessible to anyone, private apps require authentication.",
    parameters: Type.Object({
      script_name: Type.String({ description: "The name of the app/worker script." }),
      is_public: Type.Boolean({ description: "Set true for public access, false for private org-member access." }),
    }),
  },
  {
    name: "get_latest_logs",
    label: "Get Latest Logs",
    description:
      "Get recent runtime logs for a deployed app in the current workspace. Returns console and exception events captured by the tail worker.",
    parameters: Type.Object({
      script_name: Type.String({ description: "The app/worker script name to fetch logs for." }),
      limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500, description: "Maximum log entries. Defaults to 100." })),
      since_ms: Type.Optional(Type.Integer({ minimum: 0, description: "Only logs newer than this millisecond timestamp." })),
    }),
  },
  {
    name: "list_scheduled_prompts",
    label: "List Scheduled Prompts",
    description: "List scheduled prompts for the current workspace. Cron expressions use 5 fields in UTC.",
    parameters: emptyParameters,
  },
  {
    name: "create_scheduled_prompt",
    label: "Create Scheduled Prompt",
    description:
      "Create a scheduled prompt in the current workspace. The cron expression is evaluated in UTC, and a dedicated thread is created automatically.",
    parameters: Type.Object({
      name: Type.String({ description: "Friendly name for the scheduled prompt." }),
      prompt: Type.String({ description: "Prompt text to send when the schedule fires." }),
      cron_expression: Type.String({ description: "5-field cron expression in UTC: minute hour day-of-month month day-of-week." }),
      enabled: Type.Optional(Type.Boolean({ description: "Defaults to true. Set false to create a paused schedule." })),
    }),
  },
  {
    name: "update_scheduled_prompt",
    label: "Update Scheduled Prompt",
    description: "Update an existing scheduled prompt in the current workspace.",
    parameters: Type.Object({
      prompt_id: Type.String({ description: "ID of the scheduled prompt to update." }),
      name: Type.Optional(Type.String({ description: "Optional new display name." })),
      prompt: Type.Optional(Type.String({ description: "Optional new prompt text." })),
      cron_expression: Type.Optional(Type.String({ description: "Optional new 5-field UTC cron expression." })),
      enabled: Type.Optional(Type.Boolean({ description: "Optional enabled state." })),
    }),
  },
  {
    name: "delete_scheduled_prompt",
    label: "Delete Scheduled Prompt",
    description: "Delete a scheduled prompt from the current workspace.",
    parameters: Type.Object({
      prompt_id: Type.String({ description: "ID of the scheduled prompt to delete." }),
    }),
  },
  {
    name: "run_scheduled_prompt_now",
    label: "Run Scheduled Prompt Now",
    description: "Trigger a scheduled prompt immediately without waiting for its next cron time.",
    parameters: Type.Object({
      prompt_id: Type.String({ description: "ID of the scheduled prompt to run now." }),
    }),
  },
  {
    name: "list_integrations",
    label: "List Integrations",
    description: "List configured integrations (Stripe, Notion, GitHub, etc.) for the current workspace.",
    parameters: Type.Object({
      category: Type.Optional(Type.Union([
        Type.Literal("databases"),
        Type.Literal("saas"),
        Type.Literal("ai_services"),
        Type.Literal("cloud_providers"),
        Type.Literal("communication"),
      ])),
    }),
  },
  {
    name: "list_integration_types",
    label: "List Integration Types",
    description: "List all available integration types that can be configured, with their configuration schemas.",
    parameters: Type.Object({
      category: Type.Optional(Type.Union([
        Type.Literal("databases"),
        Type.Literal("saas"),
        Type.Literal("ai_services"),
        Type.Literal("cloud_providers"),
        Type.Literal("communication"),
      ])),
    }),
  },
  {
    name: "create_integration",
    label: "Create Integration",
    description:
      "Create a new integration/connection for the current workspace. Use list_integration_types to see available types and required fields.",
    parameters: Type.Object({
      integration_type: Type.String({ description: 'The type of integration, for example "stripe", "notion", "postgres", or "other".' }),
      name: Type.String({ description: "A friendly name for this connection." }),
      config: Type.Optional(Type.Any({ description: "Configuration object; fields vary by integration type." })),
      credentials: Type.Optional(Type.Any({ description: "Credential object; fields vary by integration type." })),
    }),
  },
  {
    name: "prompt_connection_setup",
    label: "Prompt Connection Setup",
    description:
      "Prompt the user to set up a new integration/connection through a secure UI modal in chat and wait for completion.",
    parameters: Type.Object({
      integration_type: Type.String({ description: 'The integration type to set up. Use "other" for custom APIs.' }),
      suggested_name: Type.Optional(Type.String({ description: "Suggested connection name to prefill." })),
      message: Type.Optional(Type.String({ description: "Message explaining why this connection is needed." })),
      display_name: Type.Optional(Type.String({ description: 'Display name for custom integrations when integration_type is "other".' })),
      description: Type.Optional(Type.String({ description: "Description for custom integrations." })),
      instructions: Type.Optional(Type.String({ description: "Setup instructions shown above the form. Supports markdown." })),
      fields: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ description: "Field name for env var suffix." }),
        label: Type.String({ description: "Display label shown in UI." }),
        type: Type.Union([Type.Literal("password"), Type.Literal("text"), Type.Literal("url"), Type.Literal("number")]),
        required: Type.Boolean({ description: "Whether the field is required." }),
        placeholder: Type.Optional(Type.String()),
        description: Type.Optional(Type.String()),
      }), { maxItems: 10 })),
    }),
  },
  {
    name: "capture_bug_report",
    label: "Capture Bug Report",
    description:
      "Capture a bug report from the currently deployed app preview, including screenshot, DOM snapshot, logs, network requests, and session recording.",
    parameters: Type.Object({
      message: Type.Optional(Type.String({ description: "Optional message explaining why you need to capture the bug report." })),
    }),
  },
  {
    name: "get_custom_domain",
    label: "Get Custom Domain",
    description:
      "Get exact custom domains configured for this organization with required DNS records, per-app hostname/SSL status, and live DNS checks.",
    parameters: emptyParameters,
  },
  {
    name: "set_custom_domain",
    label: "Set Custom Domain",
    description: "Set one exact custom hostname for one deployed app. Admin only. Wildcards are not supported.",
    parameters: Type.Object({
      app_name: Type.String({ description: "The deployed app name." }),
      hostname: Type.String({ description: 'The exact hostname, for example "example.com" or "app.example.com".' }),
    }),
  },
  {
    name: "remove_custom_domain",
    label: "Remove Custom Domain",
    description: "Remove the exact custom domain from one app. Admin only.",
    parameters: Type.Object({
      app_name: Type.String({ description: "The deployed app name." }),
    }),
  },
  {
    name: "retry_custom_domain_hostnames",
    label: "Retry Custom Domain Hostnames",
    description: "Retry Cloudflare hostname provisioning for apps whose exact custom domains are not active.",
    parameters: emptyParameters,
  },
] as const;

const setPreviewParameters = Type.Object({
  kind: Type.Optional(Type.Union([Type.Literal("file"), Type.Literal("app")], {
    description: "Preview target kind. If omitted, script_name selects app preview and path selects file preview.",
  })),
  path: Type.Optional(Type.String({ description: "Workspace, upload, or output file path to preview." })),
  content_type: Type.Optional(Type.String({ description: "Optional MIME type hint for file previews." })),
  script_name: Type.Optional(Type.String({ description: "Deployed app/worker script name to preview." })),
});

type TodoItem = {
  content: string;
  activeForm: string;
  status: "pending" | "in_progress" | "completed";
};

function normalizeTodoStatus(status: unknown): TodoItem["status"] {
  if (status === "completed") return "completed";
  if (status === "in_progress" || status === "inProgress") return "in_progress";
  return "pending";
}

function normalizeTodos(value: unknown): TodoItem[] {
  if (!Array.isArray(value)) {
    throw new Error("todos must be an array");
  }
  if (value.length > 50) {
    throw new Error("at most 50 todos are supported");
  }
  return value.map((todo, index) => {
    const raw = todo && typeof todo === "object" ? todo as Record<string, unknown> : {};
    const content = typeof raw.content === "string" ? raw.content.trim() : "";
    if (!content) {
      throw new Error(`todos[${index}].content is required`);
    }
    const activeForm = typeof raw.activeForm === "string" && raw.activeForm.trim()
      ? raw.activeForm.trim()
      : content;
    return {
      content,
      activeForm,
      status: normalizeTodoStatus(raw.status),
    };
  });
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? Math.trunc(value) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeDomains(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const domains = value
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean)
    .map((entry) => {
      try {
        const withScheme = /^[a-z]+:\/\//i.test(entry) ? entry : `https://${entry}`;
        return new URL(withScheme).hostname;
      } catch {
        return entry.split("/")[0] || entry;
      }
    })
    .map((entry) => entry.replace(/^\.+|\.+$/g, ""))
    .filter(Boolean)
    .slice(0, 20);
  return domains.length > 0 ? domains : undefined;
}

type WebProxyResponse = {
  content?: Array<{ type?: string; text?: string }>;
  error?: string;
};

function parseJsonOrSsePayload(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    const dataLines = trimmed
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim())
      .filter(Boolean);
    if (dataLines.length > 0) {
      return JSON.parse(dataLines.join("\n"));
    }
    return { raw: text };
  }
}

function parseMcpToolText(result: unknown): unknown {
  const resultObject = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const content = Array.isArray(resultObject.content) ? resultObject.content : [];
  const textPart = content.find((part) => {
    if (!part || typeof part !== "object") return false;
    const entry = part as Record<string, unknown>;
    return entry.type === "text" && typeof entry.text === "string";
  }) as Record<string, unknown> | undefined;
  const text = typeof textPart?.text === "string" ? textPart.text : "";
  if (!text) return result;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function localMcpRequest(
  message: Record<string, unknown>,
  sessionId: string | undefined,
  signal?: AbortSignal,
): Promise<{ payload: Record<string, unknown>; sessionId?: string }> {
  if (!mcpServerUrl) {
    throw new Error("CHIRIDION_HOST_MCP_SERVER_URL is not configured");
  }

  const response = await fetch(mcpServerUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify(message),
    signal,
  });
  const text = await response.text();
  const payload = parseJsonOrSsePayload(text) as Record<string, unknown>;
  if (!response.ok) {
    const error = payload.error;
    const message = error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
      ? (error as Record<string, unknown>).message as string
      : typeof error === "string"
        ? error
        : `MCP request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  if (payload.error) {
    const error = payload.error;
    const message = error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
      ? (error as Record<string, unknown>).message as string
      : JSON.stringify(error);
    throw new Error(message);
  }
  return {
    payload,
    sessionId: response.headers.get("mcp-session-id") || sessionId,
  };
}

async function closeLocalMcpSession(sessionId: string | undefined, signal?: AbortSignal): Promise<void> {
  if (!mcpServerUrl || !sessionId) return;
  await fetch(mcpServerUrl, {
    method: "DELETE",
    headers: {
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-06-18",
      "mcp-session-id": sessionId,
    },
    signal,
  }).catch(() => {});
}

async function callLocalMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let sessionId: string | undefined;
  try {
    const initialized = await localMcpRequest({
      jsonrpc: "2.0",
      id: `init_${Date.now()}`,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: {
          name: "chiridion-host-pi",
          version: "1.0.0",
        },
      },
    }, undefined, signal);
    sessionId = initialized.sessionId;
    if (!sessionId) {
      throw new Error("MCP initialize did not return a session id");
    }

    await localMcpRequest({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {},
    }, sessionId, signal);

    const response = await localMcpRequest({
      jsonrpc: "2.0",
      id: `tool_${Date.now()}`,
      method: "tools/call",
      params: { name, arguments: args },
    }, sessionId, signal);
    return parseMcpToolText(response.payload.result);
  } finally {
    await closeLocalMcpSession(sessionId, signal);
  }
}

function localMcpToolExecutor(name: string) {
  return async (
    _toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<{ content: Array<{ type: "text"; text: string }> }> => {
    const result = await callLocalMcpTool(name, params || {}, signal);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  };
}

async function executeSetPreview(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const kind = params.kind === "app" || params.kind === "file" ? params.kind : undefined;
  const scriptName = typeof params.script_name === "string" ? params.script_name.trim() : "";
  const filePath = typeof params.path === "string" ? params.path.trim() : "";

  if (kind === "app" || (!kind && scriptName)) {
    if (!scriptName) throw new Error("script_name is required for app previews");
    const result = await callLocalMcpTool("set_app_preview", { script_name: scriptName }, signal);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  if (kind === "file" || (!kind && filePath)) {
    if (!filePath) throw new Error("path is required for file previews");
    const args: Record<string, unknown> = { path: filePath };
    if (typeof params.content_type === "string" && params.content_type.trim()) {
      args.content_type = params.content_type.trim();
    }
    const result = await callLocalMcpTool("set_file_preview", args, signal);
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  }

  throw new Error("Provide either path for a file preview or script_name for an app preview");
}

async function executeWebProxyTool(
  endpointUrl: string,
  params: Record<string, unknown>,
  signal: AbortSignal | undefined,
  envName: string,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!endpointUrl) {
    throw new Error(`${envName} is not configured`);
  }
  if (!threadId) {
    throw new Error("THREAD_ID is not configured");
  }
  if (!hostPiToken) {
    throw new Error("CHIRIDION_HOST_PI_TOKEN is not configured");
  }

  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      token: hostPiToken,
      params,
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as WebProxyResponse;
  if (!response.ok) {
    throw new Error(payload.error || `Web proxy failed with HTTP ${response.status}`);
  }
  const content = Array.isArray(payload.content)
    ? payload.content
      .map((entry) => ({ type: "text" as const, text: typeof entry?.text === "string" ? entry.text : "" }))
      .filter((entry) => entry.text.trim())
    : [];
  return { content: content.length > 0 ? content : [{ type: "text", text: "No content returned." }] };
}

async function executeWebSearch(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return executeWebProxyTool(webSearchUrl, params, signal, "CHIRIDION_WEB_SEARCH_URL");
}

async function executeWebFetch(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  return executeWebProxyTool(webFetchUrl, params, signal, "CHIRIDION_WEB_FETCH_URL");
}
function resolveSubagentModel(model: unknown, agentType: "explore" | "general"): string {
  const requested = typeof model === "string" ? model.trim() : "";
  const provider = (process.env.CHIRIDION_CHAT_PROVIDER || "").trim().toLowerCase();
  const codexModel = (process.env.CHIRIDION_CODEX_MODEL || "").trim();
  const claudeModel = (process.env.CHIRIDION_CLAUDE_MODEL || "").trim();
  const openRouterUpstream = process.env.CHIRIDION_OPENROUTER_UPSTREAM === "1";
  const value = requested || (agentType === "explore"
    ? (provider === "claude" ? "haiku" : "gpt-5.4-mini")
    : (provider === "claude" ? claudeModel : codexModel));

  switch (value) {
    case "gpt-5.5":
      if (openRouterUpstream) return "camel/openai/gpt-5.5";
      return "openai/gpt-5.5";
    case "gpt-5.4-mini":
      if (openRouterUpstream) return "camel/openai/gpt-5.4-mini";
      return "openai/gpt-5.4-mini";
    case "gpt-5.4":
      if (openRouterUpstream) return "camel/openai/gpt-5.4";
      return "openai/gpt-5.4";
    case "kimi-k2.6":
    case "kimi-latest":
      return "camel/~moonshotai/kimi-latest";
    case "grok-4.3":
    case "grok-latest":
      return "camel/x-ai/grok-4.3";
    case "gemini-3-flash-preview":
      return "camel/google/gemini-3-flash-preview";
    case "gemini-3.1-pro-preview":
      return "camel/google/gemini-3.1-pro-preview";
    case "deepseek-v4-pro":
      return "camel/deepseek/deepseek-v4-pro";
    case "deepseek-v4-flash":
      return "camel/deepseek/deepseek-v4-flash";
    case "haiku":
    case "claude-haiku-4-5":
    case "claude-haiku-4-5-20251001":
      return "anthropic/claude-haiku-4-5-20251001";
    case "sonnet":
      if (openRouterUpstream) return "camel/anthropic/claude-sonnet-4.6";
      return "anthropic/claude-sonnet-4-6";
    case "opus-4.7":
    case "claude-opus-4-7":
      if (openRouterUpstream) return "camel/anthropic/claude-opus-4.7";
      return "anthropic/claude-opus-4-7";
    case "opus":
      if (openRouterUpstream) return "camel/anthropic/claude-opus-4.6";
      return "anthropic/claude-opus-4-6";
    default:
      if (value.includes("/")) return value;
      return agentType === "explore" ? "openai/gpt-5.4-mini" : "openai/gpt-5.4";
  }
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const configured = process.env.CHIRIDION_HOST_PI_PATH || process.env.HOST_PI_PATH || "";
  if (configured) return { command: configured, args };

  const currentScript = process.argv[1];
  if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }

  const execName = path.basename(process.execPath).toLowerCase();
  if (!/^(node|bun)(\.exe)?$/.test(execName)) {
    return { command: process.execPath, args };
  }

  return { command: "pi", args };
}

function getSubagentExtensionPath(): string {
  const configured = process.env.CHIRIDION_HOST_PI_EXTENSION_PATH || process.env.HOST_PI_EXTENSION_PATH || "";
  if (configured) return configured;
  return process.argv[1] || "";
}

function getSubagentSkillsPath(): string {
  const configured = (process.env.CHIRIDION_HOST_PI_SKILLS_PATH || process.env.HOST_PI_SKILLS_PATH || "").trim();
  if (!configured) return "";
  if (!fs.existsSync(configured)) {
    throw new Error(`host Pi skills unavailable at ${configured}`);
  }
  return configured;
}

function subagentPrompt(
  agentType: "explore" | "general",
  prompt: string,
  context: unknown,
  readOnly: boolean,
): string {
  const contextText = typeof context === "string" && context.trim()
    ? `\n\nAdditional context:\n${context.trim()}`
    : "";
  if (agentType === "explore") {
    return [
      "You are an explore subagent running in an isolated context window.",
      "Investigate the task and return concise findings with specific file paths, symbols, commands, or URLs as evidence.",
      "Do not modify files, install dependencies, start long-running servers, or make commits.",
      "Prefer read, ls, grep, find, WebSearch, and WebFetch.",
      "",
      `Task:\n${prompt.trim()}${contextText}`,
    ].join("\n");
  }

  return [
    "You are a delegated Pi coding subagent running in an isolated context window.",
    readOnly
      ? "This invocation is read-only. Do not modify files, install dependencies, start long-running servers, or make commits."
      : "Complete the delegated task directly. Keep changes scoped and report exactly what you did.",
    "",
    `Task:\n${prompt.trim()}${contextText}`,
  ].join("\n");
}

function extractTextFromMessage(message: Record<string, unknown>): string {
  const content = Array.isArray(message.content) ? message.content : [];
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const entry = part as Record<string, unknown>;
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function runSubagent(
  params: Record<string, unknown>,
  agentType: "explore" | "general",
  signal?: AbortSignal,
): Promise<string> {
  const prompt = typeof params.prompt === "string" ? params.prompt.trim() : "";
  if (!prompt) throw new Error("prompt is required");

  const defaultReadOnly = agentType === "explore";
  const readOnly = typeof params.readOnly === "boolean" ? params.readOnly : defaultReadOnly;
  const maxMinutes = clampInteger(params.maxMinutes, agentType === "explore" ? 3 : 5, 1, 10);
  const timeoutMs = maxMinutes * 60_000;
  const model = resolveSubagentModel(params.model, agentType);
  const extensionPath = getSubagentExtensionPath();
  if (!extensionPath) throw new Error("CHIRIDION_HOST_PI_EXTENSION_PATH is not configured");
  const skillsPath = getSubagentSkillsPath();

  const args = [
    "--mode", "json",
    "-p",
    "--no-session",
    "--no-builtin-tools",
    "-e", extensionPath,
  ];
  if (skillsPath) args.push("--skill", skillsPath);
  args.push("--model", model);
  const activeTools = readOnly
    ? ["read", "ls", "grep", "find", "WebSearch", "web_search", "WebFetch", "web_fetch"]
    : ["read", "write", "edit", "ls", "grep", "find", "bash", "WebSearch", "web_search", "WebFetch", "web_fetch"];
  args.push("--tools", activeTools.join(","));
  args.push(subagentPrompt(agentType, prompt, params.context, readOnly));

  const subagentRoot = process.env.CHIRIDION_PI_SUBAGENT_SESSION_ROOT
    || path.join(process.env.CHIRIDION_HOST_PI_SESSION_ROOT || os.tmpdir(), "subagents", threadId || "local");
  fs.mkdirSync(subagentRoot, { recursive: true });

  const invocation = getPiInvocation(args);
  const childEnv = {
    ...process.env,
    CHIRIDION_PI_SUBAGENT: "1",
    CHIRIDION_PI_READ_ONLY: readOnly ? "1" : "0",
  };

  return await new Promise<string>((resolve, reject) => {
    let stdoutBuffer = "";
    let stderr = "";
    let streamedText = "";
    let finalAssistantText = "";
    let settled = false;

    const finish = (error: Error | null, value = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", abortHandler);
      if (error) reject(error);
      else resolve(value);
    };

    const proc = spawn(invocation.command, invocation.args, {
      cwd: hostCwd,
      env: childEnv,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    const killProc = () => {
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) proc.kill("SIGKILL");
      }, 3000).unref?.();
    };

    const abortHandler = () => {
      killProc();
      finish(new Error("Subagent was aborted"));
    };

    const timer = setTimeout(() => {
      killProc();
      finish(new Error(`Subagent timed out after ${maxMinutes} minute${maxMinutes === 1 ? "" : "s"}`));
    }, timeoutMs);
    timer.unref?.();

    if (signal) {
      if (signal.aborted) abortHandler();
      else signal.addEventListener("abort", abortHandler, { once: true });
    }

    const processLine = (line: string) => {
      if (!line.trim()) return;
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      const assistantEvent = event.assistantMessageEvent && typeof event.assistantMessageEvent === "object"
        ? event.assistantMessageEvent as Record<string, unknown>
        : undefined;
      const delta = event.type === "text_delta" && typeof event.delta === "string"
        ? event.delta
        : assistantEvent?.type === "text_delta" && typeof assistantEvent.delta === "string"
          ? assistantEvent.delta
          : "";
      if (delta) {
        streamedText += delta;
        if (streamedText.length > 60000) streamedText = streamedText.slice(-60000);
      }
      if (event.type === "message_end" && event.message && typeof event.message === "object") {
        const text = extractTextFromMessage(event.message as Record<string, unknown>);
        if (text) finalAssistantText = text;
      }
    };

    proc.stdout.on("data", (data) => {
      stdoutBuffer += data.toString();
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() || "";
      for (const line of lines) processLine(line);
    });

    proc.stderr.on("data", (data) => {
      stderr += data.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    proc.on("error", (error) => finish(error));
    proc.on("close", (code) => {
      if (stdoutBuffer.trim()) processLine(stdoutBuffer);
      const output = (finalAssistantText || streamedText).trim();
      if ((code ?? 0) !== 0) {
        finish(new Error(`Subagent exited with code ${code ?? 1}${stderr ? `:\n${stderr.trim()}` : ""}`));
        return;
      }
      finish(null, output || "Subagent completed without returning text.");
    });
  });
}

async function executeExplore(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const text = await runSubagent(params, "explore", signal);
  return { content: [{ type: "text", text: truncateText(text, 60000) }] };
}

async function executeAgent(
  _toolCallId: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const agentType = params.agentType === "explore" ? "explore" : "general";
  const text = await runSubagent(params, agentType, signal);
  return { content: [{ type: "text", text: truncateText(text, 60000) }] };
}

async function executeTodoWrite(
  _toolCallId: string,
  params: { todos?: unknown },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!todoStateUrl) {
    throw new Error("CHIRIDION_TODO_STATE_URL is not configured");
  }
  if (!threadId) {
    throw new Error("THREAD_ID is not configured");
  }
  if (!hostPiToken) {
    throw new Error("CHIRIDION_HOST_PI_TOKEN is not configured");
  }

  const todos = normalizeTodos(params.todos);
  const response = await fetch(todoStateUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      token: hostPiToken,
      todos,
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new Error(payload.error || `TodoWrite failed with HTTP ${response.status}`);
  }

  return {
    content: [{ type: "text", text: `Updated todo list with ${todos.length} task${todos.length === 1 ? "" : "s"}.` }],
  };
}

async function executeAskUserQuestion(
  toolCallId: string,
  params: { questions?: unknown[] },
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  if (!askUserQuestionUrl) {
    throw new Error("CHIRIDION_ASK_USER_QUESTION_URL is not configured");
  }
  if (!threadId) {
    throw new Error("THREAD_ID is not configured");
  }
  if (!askUserQuestionToken) {
    throw new Error("CHIRIDION_ASK_USER_QUESTION_TOKEN is not configured");
  }
  const questions = Array.isArray(params.questions) ? params.questions : [];
  if (questions.length === 0) {
    throw new Error("questions are required");
  }

  const response = await fetch(askUserQuestionUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId,
      token: askUserQuestionToken,
      toolCallId,
      questions,
    }),
    signal,
  });
  const payload = (await response.json().catch(() => ({}))) as {
    answers?: Record<string, unknown>;
    error?: string;
  };
  if (!response.ok) {
    throw new Error(payload.error || `ask_user_question failed with HTTP ${response.status}`);
  }
  return {
    content: [{ type: "text", text: JSON.stringify({ answers: payload.answers || {} }, null, 2) }],
  };
}

export default function containerTools(pi: ExtensionAPI) {
  const registerProvider = (pi as unknown as {
    registerProvider?: (name: string, provider: unknown) => void;
  }).registerProvider;
  if (typeof registerProvider === "function") {
    if (process.env.OPENAI_BASE_URL) {
      registerProvider.call(pi, "openai", {
        baseUrl: process.env.OPENAI_BASE_URL,
        apiKey: "OPENAI_API_KEY",
      });
    }

    if (process.env.ANTHROPIC_BASE_URL) {
      registerProvider.call(pi, "anthropic", {
        baseUrl: process.env.ANTHROPIC_BASE_URL,
        apiKey: "ANTHROPIC_API_KEY",
      });
    }

    if (process.env.OPENROUTER_BASE_URL) {
      const openRouterBaseUrl = process.env.OPENROUTER_BASE_URL;
      const openRouterAnthropicBaseUrl = process.env.OPENROUTER_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || openRouterBaseUrl;
      const grokModel = {
        id: "x-ai/grok-4.3",
        name: "Grok 4.3",
        api: "openai-responses",
        reasoning: false,
        input: ["text", "image"],
        cost: {
          input: 1.25,
          output: 2.5,
          cacheRead: 1.25,
          cacheWrite: 0,
        },
        contextWindow: 1000000,
        maxTokens: 30000,
      };
      registerProvider.call(pi, "camel", {
        name: "camelAI",
        baseUrl: openRouterBaseUrl,
        apiKey: "CAMEL_API_KEY",
        models: [
          {
            id: "openai/gpt-5.5",
            name: "GPT-5.5",
            api: "openai-responses",
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 5,
              output: 30,
              cacheRead: 0.5,
              cacheWrite: 0,
            },
            contextWindow: 272000,
            maxTokens: 128000,
          },
          {
            id: "openai/gpt-5.4",
            name: "GPT-5.4",
            api: "openai-responses",
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 2.5,
              output: 15,
              cacheRead: 0.25,
              cacheWrite: 0,
            },
            contextWindow: 272000,
            maxTokens: 128000,
          },
          {
            id: "openai/gpt-5.4-mini",
            name: "GPT-5.4 mini",
            api: "openai-responses",
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 0.75,
              output: 4.5,
              cacheRead: 0.075,
              cacheWrite: 0,
            },
            contextWindow: 400000,
            maxTokens: 128000,
          },
          {
            id: "~moonshotai/kimi-latest",
            name: "Kimi K2.6",
            api: "openai-responses",
            reasoning: false,
            input: ["text", "image"],
            cost: {
              input: 0.7448,
              output: 4.655,
              cacheRead: 0,
              cacheWrite: 0,
            },
            contextWindow: 262144,
            maxTokens: 65536,
          },
          grokModel,
          {
            id: "google/gemini-3-flash-preview",
            name: "Gemini 3 Flash Preview",
            api: "openai-responses",
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 0.5,
              output: 3,
              cacheRead: 0.05,
              cacheWrite: 0.08333333333333334,
            },
            contextWindow: 1048576,
            maxTokens: 65536,
          },
          {
            id: "google/gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
            api: "openai-responses",
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 2,
              output: 12,
              cacheRead: 0.2,
              cacheWrite: 0.375,
            },
            contextWindow: 1048576,
            maxTokens: 65536,
          },
          {
            id: "deepseek/deepseek-v4-pro",
            name: "DeepSeek V4 Pro",
            api: "openai-responses",
            reasoning: true,
            input: ["text"],
            cost: {
              input: 0.435,
              output: 0.87,
              cacheRead: 0.003625,
              cacheWrite: 0,
            },
            contextWindow: 1048576,
            maxTokens: 384000,
          },
          {
            id: "deepseek/deepseek-v4-flash",
            name: "DeepSeek V4 Flash",
            api: "openai-responses",
            reasoning: true,
            input: ["text"],
            cost: {
              input: 0.14,
              output: 0.28,
              cacheRead: 0.0028,
              cacheWrite: 0,
            },
            contextWindow: 1048576,
            maxTokens: 384000,
          },
          {
            id: "anthropic/claude-haiku-4.5",
            name: "Claude Haiku 4.5",
            api: "anthropic-messages",
            baseUrl: openRouterAnthropicBaseUrl,
            reasoning: false,
            input: ["text", "image"],
            cost: {
              input: 1,
              output: 5,
              cacheRead: 0.1,
              cacheWrite: 1.25,
            },
            contextWindow: 200000,
            maxTokens: 64000,
          },
          {
            id: "anthropic/claude-sonnet-4.6",
            name: "Claude Sonnet 4.6",
            api: "anthropic-messages",
            baseUrl: openRouterAnthropicBaseUrl,
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 3,
              output: 15,
              cacheRead: 0.3,
              cacheWrite: 3.75,
            },
            contextWindow: 1000000,
            maxTokens: 64000,
          },
          {
            id: "anthropic/claude-opus-4.6",
            name: "Claude Opus 4.6",
            api: "anthropic-messages",
            baseUrl: openRouterAnthropicBaseUrl,
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 5,
              output: 25,
              cacheRead: 0.5,
              cacheWrite: 6.25,
            },
            contextWindow: 1000000,
            maxTokens: 128000,
          },
          {
            id: "anthropic/claude-opus-4.7",
            name: "Claude Opus 4.7",
            api: "anthropic-messages",
            baseUrl: openRouterAnthropicBaseUrl,
            reasoning: true,
            input: ["text", "image"],
            cost: {
              input: 5,
              output: 25,
              cacheRead: 0.5,
              cacheWrite: 6.25,
            },
            contextWindow: 1000000,
            maxTokens: 128000,
          },
        ],
      });
      registerProvider.call(pi, "camelai-openrouter", {
        baseUrl: openRouterBaseUrl,
        apiKey: "CAMEL_API_KEY",
        models: [grokModel],
      });
    }
  }

  if (!isSubagentProcess) {
    pi.registerTool({
      name: "AskUserQuestion",
      label: "Ask User Question",
      description: "Ask the user one to four multiple-choice clarifying questions and wait for their selections.",
      parameters: askUserQuestionParameters,
      execute: executeAskUserQuestion,
    });

    pi.registerTool({
      name: "ask_user_question",
      label: "Ask User Question",
      description: "Ask the user one to four multiple-choice clarifying questions and wait for their selections.",
      parameters: askUserQuestionParameters,
      execute: executeAskUserQuestion,
    });

    pi.registerTool({
      name: "TodoWrite",
      label: "Todo",
      description:
        "Create or update the visible task list for multi-step work. Call this with the full current list, keep exactly one task in_progress while working, mark tasks completed as they finish, and pass an empty list to clear it.",
      parameters: todoWriteParameters,
      execute: executeTodoWrite,
    });

    pi.registerTool({
      name: "Explore",
      label: "Explore",
      description:
        "Spawn a read-only Pi explore subagent with an isolated context window. Use this for parallel codebase investigation, locating relevant files, checking assumptions, or gathering concise evidence. Defaults to a weaker model: Haiku for Claude sessions and gpt-5.4-mini otherwise.",
      parameters: exploreParameters,
      execute: executeExplore,
    });

    pi.registerTool({
      name: "explore",
      label: "Explore",
      description:
        "Spawn a read-only Pi explore subagent with an isolated context window. Use this for parallel codebase investigation, locating relevant files, checking assumptions, or gathering concise evidence. Defaults to a weaker model: Haiku for Claude sessions and gpt-5.4-mini otherwise.",
      parameters: exploreParameters,
      execute: executeExplore,
    });

    pi.registerTool({
      name: "Agent",
      label: "Agent",
      description:
        "Spawn a generic Pi subagent with an isolated context window. Use agentType='explore' for read-only investigation or agentType='general' for delegated work. File tools still execute inside the sandbox container.",
      parameters: agentParameters,
      execute: executeAgent,
    });

    pi.registerTool({
      name: "agent",
      label: "Agent",
      description:
        "Spawn a generic Pi subagent with an isolated context window. Use agentType='explore' for read-only investigation or agentType='general' for delegated work. File tools still execute inside the sandbox container.",
      parameters: agentParameters,
      execute: executeAgent,
    });

    pi.registerTool({
      name: "set_preview",
      label: "Set Preview",
      description:
        "Set the chat preview panel to either a workspace/upload/output file or a deployed app. Provide path for files or script_name for apps.",
      parameters: setPreviewParameters,
      execute: executeSetPreview,
    });

    for (const definition of mcpToolDefinitions) {
      pi.registerTool({
        name: definition.name,
        label: definition.label,
        description: definition.description,
        parameters: definition.parameters,
        execute: localMcpToolExecutor(definition.name),
      });
    }
  }

  pi.registerTool({
    name: "WebSearch",
    label: "Web Search",
    description:
      "Search the web and return ranked URLs with titles, metadata, and snippets when available. Search does not fetch full page content; use WebFetch for that.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use WebSearch/web_search for current information, external documentation, news, or facts not available in the workspace.",
    ],
    parameters: webSearchParameters,
    execute: executeWebSearch,
  });

  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return ranked URLs with titles, metadata, and snippets when available. Search does not fetch full page content; use WebFetch for that.",
    promptSnippet: "Search the web for current information",
    promptGuidelines: [
      "Use WebSearch/web_search for current information, external documentation, news, or facts not available in the workspace.",
    ],
    parameters: webSearchParameters,
    execute: executeWebSearch,
  });

  pi.registerTool({
    name: "WebFetch",
    label: "Web Fetch",
    description:
      "Fetch clean LLM-ready content from a URL. Use this after search or when the user gives a specific URL.",
    promptSnippet: "Fetch clean content from a URL",
    promptGuidelines: [
      "Use WebFetch/web_fetch when the user gives a URL or after WebSearch returns a page that needs to be read.",
    ],
    parameters: webFetchParameters,
    execute: executeWebFetch,
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch clean LLM-ready content from a URL. Use this after search or when the user gives a specific URL.",
    promptSnippet: "Fetch clean content from a URL",
    promptGuidelines: [
      "Use WebFetch/web_fetch when the user gives a URL or after WebSearch returns a page that needs to be read.",
    ],
    parameters: webFetchParameters,
    execute: executeWebFetch,
  });

  pi.registerTool(createReadToolDefinition(containerCwd, { operations: containerReadOperations }));

  if (!isReadOnlySubagent) {
    pi.registerTool(createWriteToolDefinition(containerCwd, { operations: containerWriteOperations }));
    pi.registerTool(createEditToolDefinition(containerCwd, { operations: containerEditOperations }));
  }

  pi.registerTool({
    name: "ls",
    label: "ls",
    description:
      "List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. Includes dotfiles. Output is truncated to 500 entries or 50KB (whichever is hit first).",
    promptSnippet: "List directory contents",
    parameters: Type.Object({
      path: Type.Optional(Type.String({ description: "Directory to list (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of entries to return (default: 500)" })),
    }),
    execute: async (_toolCallId, params, signal) =>
      runReadOnlyJsonTool({ path: params.path ? toReadableContainerPath(params.path) : ".", limit: params.limit }, builtinLikeLsScript, signal),
  });

  pi.registerTool({
    name: "grep",
    label: "grep",
    description:
      "Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to 100 matches or 50KB (whichever is hit first). Long lines are truncated to 500 chars.",
    promptSnippet: "Search file contents for patterns (respects .gitignore)",
    parameters: Type.Object({
      pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
      path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
      glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
      ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
      literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
      context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
    }),
    async execute(_toolCallId, params, signal) {
      return runReadOnlyJsonTool(
        {
          pattern: params.pattern,
          path: toReadableContainerPath(params.path || "."),
          glob: params.glob,
          ignoreCase: params.ignoreCase,
          literal: params.literal,
          context: params.context,
          limit: params.limit,
        },
        builtinLikeGrepScript,
        signal,
      );
    },
  });

  pi.registerTool({
    name: "find",
    label: "find",
    description:
      "Search for files by glob pattern. Returns matching file paths relative to the search directory. Respects .gitignore. Output is truncated to 1000 results or 50KB (whichever is hit first).",
    promptSnippet: "Find files by glob pattern (respects .gitignore)",
    parameters: Type.Object({
      pattern: Type.String({
        description: "Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'",
      }),
      path: Type.Optional(Type.String({ description: "Directory to search in (default: current directory)" })),
      limit: Type.Optional(Type.Number({ description: "Maximum number of results (default: 1000)" })),
    }),
    async execute(_toolCallId, params, signal) {
      return runReadOnlyJsonTool(
        { pattern: params.pattern, path: toReadableContainerPath(params.path || "."), limit: params.limit },
        builtinLikeFindScript,
        signal,
      );
    },
  });

  if (!isReadOnlySubagent) {
    pi.registerTool(createBashToolDefinition(containerCwd, { operations: containerBashOperations }));
  }
}
