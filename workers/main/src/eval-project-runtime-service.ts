import { WorkerEntrypoint } from "cloudflare:workers";
import { getSandbox, type Sandbox } from "@cloudflare/sandbox";

import {
  cloneEvalDeployContext,
  upsertEvalDeployContext,
} from "./eval-deploy-context.js";

interface EvalProjectRuntimeEnv {
  EVAL_SANDBOX: DurableObjectNamespace<Sandbox>;
  APP_DB?: D1Database;
}

interface RuntimeExecBody {
  cmd?: unknown;
  cwd?: unknown;
  env?: unknown;
}

interface RuntimeCloneBody {
  targetProjectId?: unknown;
}

function json(value: unknown, init?: ResponseInit): Response {
  return Response.json(value, init);
}

function errorResponse(message: string, status = 500): Response {
  return json({ success: false, error: message }, { status });
}

function toStringMap(value: unknown): Record<string, string | undefined> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const EXIT_CODE_MARKER = "__CAMELAI_EVAL_COMMAND_EXIT_CODE__=";

function commandFromBody(body: RuntimeExecBody): string | null {
  if (typeof body.cmd === "string") return body.cmd;
  if (!Array.isArray(body.cmd)) return null;
  const parts = body.cmd.map((part) => String(part));
  if (parts.length === 3 && parts[0] === "bash" && parts[1] === "-lc") {
    return parts[2] || "";
  }
  return parts.map(shellQuote).join(" ");
}

function normalizeProjectPath(value: string | null): string {
  const raw = value?.trim() || "/workspace";
  return raw.startsWith("/") ? raw : `/workspace/${raw}`;
}

function execErrorResult(error: unknown): {
  success: false;
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const record =
    error && typeof error === "object" ? error as Record<string, unknown> : {};
  const context =
    record.context && typeof record.context === "object"
      ? record.context as Record<string, unknown>
      : {};
  const exitCode =
    typeof context.exitCode === "number"
      ? context.exitCode
      : typeof record.exitCode === "number"
        ? record.exitCode
        : 1;
  return {
    success: false,
    stdout: typeof context.stdout === "string" ? context.stdout : "",
    stderr: error instanceof Error ? error.message : String(error),
    exitCode,
  };
}

function sandboxSafeCommand(command: string): string {
  return [
    "__camelai_stdout=$(mktemp)",
    "__camelai_stderr=$(mktemp)",
    "(",
    command,
    ") >\"$__camelai_stdout\" 2>\"$__camelai_stderr\"",
    "__camelai_exit=$?",
    "cat \"$__camelai_stdout\"",
    "cat \"$__camelai_stderr\" >&2",
    `printf '\\n${EXIT_CODE_MARKER}%s\\n' "$__camelai_exit" >&2`,
    "rm -f \"$__camelai_stdout\" \"$__camelai_stderr\"",
  ].join("\n");
}

function normalizeSandboxExecResult(result: {
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const stderr = typeof result.stderr === "string" ? result.stderr : "";
  const markerIndex = stderr.lastIndexOf(EXIT_CODE_MARKER);
  if (markerIndex < 0) {
    const exitCode = typeof result.exitCode === "number" ? result.exitCode : result.success ? 0 : 1;
    return {
      success: exitCode === 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr,
      exitCode,
    };
  }

  const beforeMarker = stderr.slice(0, markerIndex).replace(/\n$/, "");
  const markerLine = stderr.slice(markerIndex).split("\n")[0] ?? "";
  const parsedExitCode = Number(markerLine.slice(EXIT_CODE_MARKER.length));
  const exitCode = Number.isInteger(parsedExitCode) ? parsedExitCode : 1;
  return {
    success: exitCode === 0,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: beforeMarker,
    exitCode,
  };
}

async function requireSandboxCommand(result: Promise<{
  success?: boolean;
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}>): Promise<void> {
  const normalized = await result.then(normalizeSandboxExecResult, execErrorResult);
  if (!normalized.success) {
    throw new Error(normalized.stderr || normalized.stdout || `Command failed with exit code ${normalized.exitCode}`);
  }
}

/**
 * Test/eval-only service binding that mimics project-runtime-service using
 * Cloudflare Sandbox SDK containers.
 */
export class EvalProjectRuntimeService extends WorkerEntrypoint<EvalProjectRuntimeEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return json({ service: "eval-project-runtime-service", ok: true });
    }

    const match = url.pathname.match(/^\/v1\/projects\/([^/]+)(\/.*)$/);
    if (!match) return errorResponse("Not found", 404);

    const [, projectId, subpath] = match;
    const sandbox = getSandbox(this.env.EVAL_SANDBOX, projectId, {
      normalizeId: true,
      transport: "rpc",
    });

    try {
      if (request.method === "POST" && subpath === "/exec") {
        const body = (await request.json().catch(() => ({}))) as RuntimeExecBody;
        const command = commandFromBody(body);
        if (!command) return errorResponse("cmd is required", 400);
        const env = toStringMap(body.env);
        await upsertEvalDeployContext(this.env.APP_DB, {
          containerId: projectId,
          orgId: env.EVAL_ORG_ID || env.ORG_ID || "",
          workspaceId: env.EVAL_WORKSPACE_ID || env.WORKSPACE_ID || "",
          userId: env.EVAL_USER_ID || "eval",
          threadId: env.EVAL_THREAD_ID || null,
          projectId,
        });
        const result = await sandbox.exec(sandboxSafeCommand(command), {
          cwd: typeof body.cwd === "string" && body.cwd.trim() ? body.cwd.trim() : "/workspace",
          env,
        }).then(normalizeSandboxExecResult, execErrorResult);
        return json({
          success: result.success,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }

      if (request.method === "PUT" && subpath === "/fs/write") {
        const path = normalizeProjectPath(url.searchParams.get("path"));
        const bytes = new Uint8Array(await request.arrayBuffer());
        await sandbox.writeFile(path, bytesToBase64(bytes), { encoding: "base64" });
        return json({ success: true, path });
      }

      if (request.method === "GET" && subpath === "/fs/read") {
        const path = normalizeProjectPath(url.searchParams.get("path"));
        const result = await sandbox.readFile(path, { encoding: "base64" });
        return new Response(base64ToBytes(result.content), {
          headers: { "Content-Type": "application/octet-stream" },
        });
      }

      if (request.method === "POST" && subpath === "/fs/mkdir") {
        const path = normalizeProjectPath(url.searchParams.get("path"));
        await sandbox.mkdir(path, { recursive: true });
        return json({ success: true, path });
      }

      if (request.method === "GET" && subpath === "/fs/list") {
        const path = normalizeProjectPath(url.searchParams.get("path"));
        const recursive = url.searchParams.get("recursive") === "1";
        const includeHidden = url.searchParams.get("includeHidden") !== "0";
        const result = await sandbox.listFiles(path, { recursive, includeHidden });
        const files = result.files.map((file) => ({
          name: file.name,
          type: file.type === "directory" ? "directory" : "file",
          size: file.size,
          modifiedAt: file.modifiedAt,
          relativePath: file.relativePath,
          absolutePath: file.absolutePath,
        }));
        return json({
          success: true,
          files,
          count: files.length,
          path,
          recursive,
        });
      }

      if (request.method === "GET" && subpath === "/fs/exists") {
        const path = normalizeProjectPath(url.searchParams.get("path"));
        const exists = await sandbox.exists(path);
        if (!exists.exists) return json({ exists: false });
        const stat = await sandbox.exec(
          `if [ -f ${shellQuote(path)} ]; then echo file; elif [ -d ${shellQuote(path)} ]; then echo directory; else echo other; fi`,
        );
        const kind = stat.stdout.trim();
        return json({
          exists: true,
          isFile: kind === "file",
          isDirectory: kind === "directory",
        });
      }

      if (request.method === "POST" && subpath === "/clone") {
        const body = (await request.json().catch(() => ({}))) as RuntimeCloneBody;
        if (typeof body.targetProjectId !== "string" || !body.targetProjectId.trim()) {
          return errorResponse("targetProjectId is required", 400);
        }
        const targetProjectId = body.targetProjectId.trim();
        const targetSandbox = getSandbox(this.env.EVAL_SANDBOX, targetProjectId, {
          normalizeId: true,
          transport: "rpc",
        });
        const archiveName = `camelai-eval-clone-${crypto.randomUUID()}.tar`;
        const sourceArchive = `/tmp/${archiveName}`;
        const targetArchive = `/tmp/${archiveName}`;
        await requireSandboxCommand(sandbox.exec(
          sandboxSafeCommand([
            "mkdir -p /workspace",
            `rm -f ${shellQuote(sourceArchive)}`,
            `tar -C /workspace -cf ${shellQuote(sourceArchive)} .`,
          ].join("\n")),
        ));
        const archive = await sandbox.readFile(sourceArchive, { encoding: "base64" });
        await targetSandbox.mkdir("/workspace", { recursive: true });
        await targetSandbox.writeFile(targetArchive, archive.content, { encoding: "base64" });
        await requireSandboxCommand(targetSandbox.exec(
          sandboxSafeCommand([
            "mkdir -p /workspace",
            "find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +",
            `tar -C /workspace -xf ${shellQuote(targetArchive)}`,
            `rm -f ${shellQuote(targetArchive)}`,
          ].join("\n")),
        ));
        await requireSandboxCommand(sandbox.exec(
          sandboxSafeCommand(`rm -f ${shellQuote(sourceArchive)}`),
        ));
        await cloneEvalDeployContext(this.env.APP_DB, projectId, targetProjectId);
        return json({ success: true });
      }

      return errorResponse("Not found", 404);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResponse(message);
    }
  }
}
