import type {
  ProjectVmEnv,
  VmCloneProjectArgs,
  VmExecArgs,
  VmFileArgs,
} from "./project-vm-protocol";
import {
  EVAL_CLOUDFLARE_API_BASE_URL,
  normalizeGlobalProjectId,
  projectRuntimeConnectionsRpcUrl,
  projectRuntimeDeployProxyUrl,
  PROJECT_RUNTIME_PROVIDER,
  PROJECT_VM_CHECKOUT_PATH,
  runtimeArtifactsProxyRemote,
} from "./project-vm-protocol";
import {
  type WorkspaceProject,
  type WorkspaceFilesystemLike,
} from "./workspace-filesystem-do";
import {
  detectSupportedImageMimeType,
  inlineImageMaxBase64Chars,
  prepareInlineImageFromStream,
  readImageSniffBytesAndReplayStream,
  readStreamBytes,
  type PreparedInlineImage,
} from "./image-tool-content";

const PROJECT_ROOT = PROJECT_VM_CHECKOUT_PATH;

export type ProjectRuntimeServiceVmEnv = ProjectVmEnv;

interface ProjectRuntimeTarget {
  projectId: string;
  projectName: string;
  projectRoot: string;
  project: WorkspaceProject;
  summary: Record<string, string>;
}

interface RuntimeExecResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface RuntimeListResult {
  success?: boolean;
  files: Array<{
    name: string;
    type: "file" | "directory";
    size: number;
    modifiedAt: string;
    relativePath?: string;
    absolutePath?: string;
  }>;
  count: number;
  path: string;
  recursive?: boolean;
}

interface RuntimeExistsResult {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
}

export interface ProjectVmTransferFile {
  path: string;
  relativePath: string;
  size?: number;
}

export class ProjectRuntimeServiceVmBridge {
  constructor(
    private readonly options: {
      env: ProjectRuntimeServiceVmEnv;
      workspace: WorkspaceFilesystemLike;
      commandEnv?: () => Promise<Record<string, string>> | Record<string, string>;
    },
  ) {}

  async exec(args: VmExecArgs): Promise<RuntimeExecResult> {
    const command = typeof args.command === "string" ? args.command.trim() : "";
    if (!command) throw new Error("command is required");

    const target = await this.getReadyTarget(args);
    return this.execRaw(target, command, {
      cwd:
        typeof args.cwd === "string" && args.cwd.trim()
          ? this.resolveVmToolPath(args.cwd, target)
          : target.projectRoot,
      timeoutMs: normalizeTimeoutMs(args),
      env: normalizeStringMap(args.env),
    });
  }

  async cloneProject(args: VmCloneProjectArgs = {}): Promise<unknown> {
    const sourceProject = requireProjectName(args.sourceProject ?? args.sourceProjectId, "sourceProject");
    const sourceTarget = await this.resolveTarget({ project: sourceProject });
    const project = await this.options.workspace.cloneProject({ ...args, sourceProject });
    const target = this.targetFromProject(project);
    await this.fetchRuntimeJson(this.projectUrl(sourceTarget.projectId, "/clone"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ targetProjectId: target.projectId }),
    });

    return {
      success: true,
      project: project.name,
    };
  }

  async read(args: VmFileArgs): Promise<unknown> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target);
    const response = await this.fetchRuntime(this.projectUrl(target.projectId, "/fs/read", { path }));
    if (response.status === 404) {
      throw new Error(`File not found: ${path}`);
    }
    if (!response.ok) {
      throw new Error((await response.text()) || `Read failed: ${response.status}`);
    }

    const images = (this.options.env as { IMAGES: ImagesBinding }).IMAGES;
    if (!response.body) {
      throw new Error(`Read failed: ${path} response body is not streamable`);
    }
    const sniffed = await readImageSniffBytesAndReplayStream(response.body);
    const imageMimeType = detectSupportedImageMimeType(sniffed.prefix);
    if (imageMimeType) {
      const contentLength = Number(response.headers.get("content-length") || "0") || undefined;
      const prepared = await prepareInlineImageFromStream(sniffed.stream, imageMimeType, images, {
        createRetryStream: async () => {
          const retryResponse = await this.fetchRuntime(this.projectUrl(target.projectId, "/fs/read", { path }));
          if (!retryResponse.ok) throw new Error((await retryResponse.text()) || `Read failed: ${retryResponse.status}`);
          if (!retryResponse.body) throw new Error(`Read failed: ${path} response body is not streamable`);
          return retryResponse.body;
        },
      });
      return projectVmImageResult({
        target: target.summary,
        path,
        size: contentLength ?? null,
        imageMimeType,
        prepared,
      });
    }
    const bytes = await readStreamBytes(sniffed.stream);

    if (isLikelyBinary(bytes)) {
      return {
        text: `[Binary file omitted: ${path}]`,
        content: [{ type: "text", text: `[Binary file omitted: ${path}]` }],
        details: {
          provider: PROJECT_RUNTIME_PROVIDER,
          target: target.summary,
          path,
          size: bytes.byteLength,
          isBinary: true,
          encoding: "base64",
        },
      };
    }
    const content = new TextDecoder().decode(bytes);
    const lines = content.split("\n");
    const start = typeof args.offset === "number" ? Math.max(0, Math.floor(args.offset) - 1) : 0;
    const limit = typeof args.limit === "number" ? Math.max(1, Math.floor(args.limit)) : undefined;
    const selected = lines.slice(start, limit ? start + limit : undefined).join("\n");
    return vmTextResult(selected, {
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      path,
      size: bytes.byteLength,
      totalLines: lines.length,
    });
  }

  async readFileStream(args: VmFileArgs): Promise<{ response: Response; path: string }> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target);
    const response = await this.fetchRuntime(this.projectUrl(target.projectId, "/fs/read", { path }));
    if (response.status === 404) {
      throw new Error(`File not found: ${path}`);
    }
    if (!response.ok) {
      throw new Error((await response.text()) || `Read failed: ${response.status}`);
    }
    return { response, path };
  }

  async assertFileReadable(args: VmFileArgs): Promise<{ path: string }> {
    const stream = await this.readFileStream(args);
    await stream.response.body?.cancel().catch(() => {});
    return { path: stream.path };
  }

  async readFileBytesForTransfer(args: VmFileArgs): Promise<{ path: string; bytes: Uint8Array; contentType?: string }> {
    const { response, path } = await this.readFileStream(args);
    return {
      path,
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get("content-type") || undefined,
    };
  }

  async writeFileBytesForTransfer(args: VmFileArgs, bytes: Uint8Array): Promise<{ path: string; bytes: number }> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target);
    await this.writeBytes(target, path, bytes);
    return { path, bytes: bytes.byteLength };
  }

  async resolvePathForTransfer(args: VmFileArgs): Promise<{ path: string }> {
    const target = await this.getReadyTarget(args);
    return { path: this.resolveVmToolPath(args.path, target) };
  }

  async statPathForTransfer(args: VmFileArgs): Promise<{ path: string; isFile: boolean; isDirectory: boolean; size?: number }> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target, target.projectRoot);
    const exists = await this.fetchRuntimeJson<RuntimeExistsResult>(
      this.projectUrl(target.projectId, "/fs/exists", { path }),
    );
    if (!exists.exists) throw new Error(`Path not found: ${path}`);
    return {
      path,
      isFile: exists.isFile === true,
      isDirectory: exists.isDirectory === true,
      size: exists.size,
    };
  }

  async collectFilesForTransfer(args: VmFileArgs): Promise<ProjectVmTransferFile[]> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target, target.projectRoot);
    const exists = await this.fetchRuntimeJson<RuntimeExistsResult>(
      this.projectUrl(target.projectId, "/fs/exists", { path }),
    );
    if (exists.isFile) {
      return [{ path, relativePath: basenamePath(path), size: exists.size }];
    }
    if (!exists.isDirectory) {
      throw new Error(`Path not found: ${path}`);
    }
    const listing = await this.listRuntimeFiles(target, path, {
      recursive: true,
      includeHidden: true,
    });
    return listing.files
      .filter((entry) => entry.type === "file")
      .map((entry) => {
        const relativePath = entry.relativePath || entry.name;
        const childPath = joinAbsolutePath(path, relativePath);
        return {
          path: childPath,
          relativePath,
          size: entry.size,
        };
      })
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }

  async deletePathForTransfer(args: VmFileArgs, options: { recursive?: boolean; force?: boolean } = {}): Promise<{ path: string }> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target);
    const flags = `${options.recursive ? "r" : ""}${options.force ? "f" : ""}`;
    await this.mustExec(target, `rm ${flags ? `-${flags} ` : ""}${shellQuote(path)}`);
    return { path };
  }

  async write(args: VmFileArgs): Promise<unknown> {
    if (typeof args.content !== "string") throw new Error("content must be a string");
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target);
    await this.writeBytes(target, path, new TextEncoder().encode(args.content));
    return vmTextResult(`Successfully wrote ${args.content.length} bytes to ${path}`, {
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      path,
    });
  }

  async edit(args: VmFileArgs): Promise<unknown> {
    const edits = normalizeEdits(args.edits);
    if (edits.length === 0) throw new Error("edits must contain at least one replacement");
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target);
    const file = await this.readTextFile(target, path);
    const after = applyExactEdits(file, edits, path);
    await this.writeBytes(target, path, new TextEncoder().encode(after));
    return vmTextResult(`Successfully replaced ${edits.length} block(s) in ${path}.`, {
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      path,
      firstChangedLine: firstChangedLine(file, after),
    });
  }

  async ls(args: VmFileArgs): Promise<unknown> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target, target.projectRoot);
    const response = await this.listRuntimeFiles(target, path, {
      recursive: args.recursive === true,
      includeHidden: args.includeHidden !== false,
    });
    const limit = Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 500);
    const text = response.files
      .slice(0, limit)
      .map((entry) => `${entry.relativePath || entry.name}${entry.type === "directory" ? "/" : ""}`)
      .join("\n") || "(empty directory)";
    return vmTextResult(text, {
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      path,
      count: response.files.length,
      truncated: response.files.length > limit,
    });
  }

  async grep(args: VmFileArgs): Promise<unknown> {
    if (typeof args.pattern !== "string" || !args.pattern.trim()) {
      throw new Error("pattern is required");
    }
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target, target.projectRoot);
    const script = `
import fnmatch, json, os, re, sys
cfg = json.loads(${JSON.stringify(JSON.stringify({
  path,
  pattern: args.pattern,
  glob: typeof args.glob === "string" && args.glob.trim() ? args.glob.trim() : undefined,
  limit: typeof args.limit === "number" ? args.limit : 100,
  ignoreCase: args.ignoreCase === true,
  literal: args.literal === true,
}))})
root = cfg["path"]
pattern = cfg["pattern"]
glob = cfg.get("glob")
limit = int(cfg.get("limit") or 100)
ignore_case = bool(cfg.get("ignoreCase"))
literal = bool(cfg.get("literal"))
flags = re.IGNORECASE if ignore_case else 0
regex = None if literal else re.compile(pattern, flags)
needle = pattern.lower() if ignore_case else pattern
matches = []
def iter_files(p):
    if os.path.isfile(p):
        yield p
    elif os.path.isdir(p):
        for base, dirs, names in os.walk(p):
            dirs[:] = [d for d in dirs if d not in {".git", "node_modules/.cache"}]
            for name in names:
                yield os.path.join(base, name)
    else:
        raise FileNotFoundError(p)
for file_path in iter_files(root):
    rel = os.path.relpath(file_path, root if os.path.isdir(root) else os.path.dirname(root))
    if glob and not fnmatch.fnmatch(rel, glob):
        continue
    try:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as handle:
            for index, line in enumerate(handle, 1):
                haystack = line.lower() if ignore_case else line
                if (regex.search(line) if regex else needle in haystack):
                    matches.append(f"{rel}:{index}: {line.strip()[:500]}")
                    if len(matches) >= limit:
                        print("\\n".join(matches))
                        sys.exit(0)
    except OSError:
        continue
print("\\n".join(matches))
`;
    const result = await this.execRaw(target, `python3 -c ${shellQuote(script)}`);
    if (!result.success) throw new Error(result.stderr || result.stdout || "VM grep failed");
    return vmTextResult(result.stdout.trim() || "No matches found", {
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      path,
    });
  }

  async find(args: VmFileArgs): Promise<unknown> {
    const target = await this.getReadyTarget(args);
    const path = this.resolveVmToolPath(args.path, target, target.projectRoot);
    const pattern = typeof args.pattern === "string" && args.pattern.trim() ? args.pattern.trim() : "*";
    const limit = Math.max(1, typeof args.limit === "number" ? Math.floor(args.limit) : 1000);
    const result = await this.mustExec(
      target,
      `find ${shellQuote(path)} -type f ! -path '*/.git/*' ! -path '*/node_modules/.cache/*' -name ${shellQuote(pattern)} -print | head -n ${limit}`,
    );
    const root = normalizeVmPath(path);
    const text = result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((entry) => relativeUnderRoot(root, entry))
      .join("\n") || "No files found matching pattern";
    return vmTextResult(text, {
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      path,
      pattern,
    });
  }

  private async getReadyTarget(args: { location?: unknown; project?: unknown; projectId?: unknown }): Promise<ProjectRuntimeTarget> {
    const target = await this.resolveTarget(args);
    await this.ensureProjectCheckout(target);
    return target;
  }

  private async resolveTarget(args: { location?: unknown; project?: unknown; projectId?: unknown }): Promise<ProjectRuntimeTarget> {
    const projectName = normalizeOptionalProjectName(args.project);
    if (projectName) {
      const project = await this.options.workspace.getProjectByName(projectName);
      if (!project) throw new Error(`Project not found: ${projectName}`);
      return this.targetFromProject(project);
    }
    const projectId = normalizeOptionalRegistryId(args.projectId);
    if (projectId) {
      const project = await this.options.workspace.getProject(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      return this.targetFromProject(project);
    }
    throw new Error("project is required for project VM operations");
  }

  private targetFromProject(project: WorkspaceProject): ProjectRuntimeTarget {
    return {
      projectId: project.id,
      projectName: project.name,
      projectRoot: PROJECT_ROOT,
      project,
      summary: {
        provider: PROJECT_RUNTIME_PROVIDER,
        project: project.name,
        projectRoot: PROJECT_ROOT,
      },
    };
  }

  private async ensureProjectCheckout(target: ProjectRuntimeTarget): Promise<void> {
    const project = target.project;
    if (!project.artifactRemote || project.artifactStatus === "error") {
      if ((this.options.env as { RUN_AGENT_EVALS?: string }).RUN_AGENT_EVALS !== "1") {
        throw new Error(`${project.name} does not have a ready Artifacts remote`);
      }
    }

    const branch = project.artifactDefaultBranch || "main";
    const remote = project.artifactRemote
      ? runtimeArtifactsProxyRemote(
          this.options.env.PROJECT_RUNTIME_ARTIFACTS_PROXY_BASE,
          this.options.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL,
        )
      : undefined;
    const script = `
set -eu
checkout=${shellQuote(target.projectRoot)}
branch=${shellQuote(branch)}
remote=${remote ? shellQuote(remote) : "''"}
mkdir -p "$checkout"
cd "$checkout"
if [ ! -d .git ]; then
  git init -b "$branch" >/dev/null 2>&1 || git init >/dev/null 2>&1
fi
git config user.name "camelAI Agent"
git config user.email "agent@camelai.dev"
git config --global --add safe.directory "$checkout" >/dev/null 2>&1 || true
if [ ! -e .gitignore ]; then
  cat > .gitignore <<'EOF'
node_modules/
.cache/
.next/
.nuxt/
.svelte-kit/
dist/
build/
coverage/
.wrangler/
.dev.vars
*.log
EOF
fi
if [ -n "$remote" ]; then
  if git remote get-url origin >/dev/null 2>&1; then
    git remote set-url origin "$remote"
  else
    git remote add origin "$remote"
  fi
fi
`;
    await this.mustExec(target, script, { timeoutMs: 30_000 });
  }

  private resolveVmToolPath(value: unknown, target: ProjectRuntimeTarget, fallback?: string): string {
    if (typeof value !== "string" || !value.trim()) {
      if (fallback) return normalizeVmPath(fallback);
      throw new Error("path is required");
    }
    const raw = value.trim();
    if (target.projectRoot) {
      const relative = raw.startsWith(target.projectRoot)
        ? raw.slice(target.projectRoot.length)
        : raw;
      return joinAbsolutePath(target.projectRoot, relative);
    }
    return normalizeVmPath(raw);
  }

  private async execRaw(
    target: ProjectRuntimeTarget,
    command: string,
    options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
  ): Promise<RuntimeExecResult> {
    const controller = new AbortController();
    const timeout = Number.isFinite(options.timeoutMs) && options.timeoutMs
      ? setTimeout(() => controller.abort(), Math.max(1, options.timeoutMs))
      : undefined;
    try {
      return await this.fetchRuntimeJson<RuntimeExecResult>(this.projectUrl(target.projectId, "/exec"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cmd: ["bash", "-lc", command],
          cwd: options.cwd,
          env: {
            ...(await this.commandEnv()),
            ...normalizeStringMap(options.env),
          },
        }),
        signal: controller.signal,
      });
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async mustExec(
    target: ProjectRuntimeTarget,
    command: string,
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<RuntimeExecResult> {
    const result = await this.execRaw(target, command, options);
    if (!result.success) {
      throw new Error(result.stderr || result.stdout || "VM command failed");
    }
    return result;
  }

  private async readTextFile(target: ProjectRuntimeTarget, path: string): Promise<string> {
    const response = await this.fetchRuntime(this.projectUrl(target.projectId, "/fs/read", { path }));
    if (!response.ok) {
      throw new Error((await response.text()) || `Failed to read ${path}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (isLikelyBinary(bytes)) throw new Error(`Cannot edit binary file: ${path}`);
    return new TextDecoder().decode(bytes);
  }

  private async writeBytes(target: ProjectRuntimeTarget, path: string, bytes: Uint8Array): Promise<void> {
    const response = await this.fetchRuntime(this.projectUrl(target.projectId, "/fs/write", { path }), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: toArrayBuffer(bytes),
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Failed to write ${path}`);
    }
  }

  private async listRuntimeFiles(
    target: ProjectRuntimeTarget,
    path: string,
    options: { recursive?: boolean; includeHidden?: boolean } = {},
  ): Promise<RuntimeListResult> {
    return this.fetchRuntimeJson<RuntimeListResult>(
      this.projectUrl(target.projectId, "/fs/list", {
        path,
        recursive: options.recursive ? "1" : "0",
        includeHidden: options.includeHidden === false ? "0" : "1",
      }),
    );
  }

  private async listVmFiles(paths: string[], target: ProjectRuntimeTarget): Promise<string[]> {
    const out: string[] = [];
    for (const path of paths) {
      const exists = await this.fetchRuntimeJson<RuntimeExistsResult>(
        this.projectUrl(target.projectId, "/fs/exists", { path }),
      );
      if (exists.isFile) {
        out.push(path);
        continue;
      }
      if (!exists.isDirectory) {
        throw new Error(`Path not found: ${path}`);
      }
      const listing = await this.listRuntimeFiles(target, path, {
        recursive: true,
        includeHidden: true,
      });
      for (const entry of listing.files) {
        if (entry.type !== "file") continue;
        out.push(joinAbsolutePath(path, entry.relativePath || entry.name));
      }
    }
    return [...new Set(out.map(normalizeVmPath))].sort();
  }

  private projectUrl(projectId: string, subpath: string, query?: Record<string, string>): string {
    const base = this.runtimeBaseUrl();
    const prefix = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
    base.pathname = `${prefix}/v1/projects/${encodeURIComponent(projectId)}${subpath}`;
    base.search = "";
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        base.searchParams.set(key, value);
      }
    }
    return base.toString();
  }

  private runtimeBaseUrl(): URL {
    const raw = this.options.env.PROJECT_RUNTIME_SERVICE_URL?.trim();
    if (raw) return new URL(raw);
    if (this.options.env.PROJECT_RUNTIME_HOST) return new URL("http://project-runtime");
    throw new Error("PROJECT_RUNTIME_HOST binding is not configured for project-runtime-service backend");
  }

  private async fetchRuntimeJson<T = unknown>(url: string, init: RequestInit = {}): Promise<T> {
    const response = await this.fetchRuntime(url, init);
    const text = await response.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // Keep text for diagnostics.
    }
    if (!response.ok) {
      throw new Error(readErrorMessage(parsed) || `Project runtime service returned ${response.status}`);
    }
    return parsed as T;
  }

  private async fetchRuntime(url: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    const token = this.options.env.PROJECT_RUNTIME_SERVICE_BEARER_TOKEN?.trim();
    if (token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    const nextInit = { ...init, headers };
    if (this.options.env.PROJECT_RUNTIME_SERVICE_URL?.trim()) {
      return fetch(url, nextInit);
    }
    const binding = this.options.env.PROJECT_RUNTIME_HOST;
    if (!binding) {
      throw new Error("PROJECT_RUNTIME_HOST binding is not configured for project-runtime-service backend");
    }
    return binding.fetch(url, nextInit);
  }

  private async commandEnv(): Promise<Record<string, string> | undefined> {
    const provider = this.options.commandEnv;
    const raw = provider ? (typeof provider === "function" ? await provider() : provider) : {};
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (typeof value === "string" && value.length > 0) {
        env[key] = value;
      }
    }
    env.CLOUDFLARE_API_BASE_URL =
      (this.options.env as { RUN_AGENT_EVALS?: string }).RUN_AGENT_EVALS === "1"
        ? EVAL_CLOUDFLARE_API_BASE_URL
        : this.deployDockerProxyUrl();
    env.CLOUDFLARE_API_TOKEN ||= "project-runtime-proxy";
    env.CLOUDFLARE_ACCOUNT_ID ||= this.options.env.CF_ACCOUNT_ID?.trim() || "chiridion";
    env.CAMELAI_CONNECTIONS_RPC_URL = projectRuntimeConnectionsRpcUrl(
      this.options.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL,
    );
    return Object.keys(env).length > 0 ? env : undefined;
  }

  private deployDockerProxyUrl(): string {
    return projectRuntimeDeployProxyUrl(this.options.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL);
  }

}

function normalizeVmPath(path: string): string {
  if (!path.trim()) throw new Error("VM path must be non-empty");
  return normalizeAbsolutePath(path);
}

function normalizeAbsolutePath(path: string): string {
  const absolute = path.startsWith("/") ? path : `/${path}`;
  const parts: string[] = [];
  for (const part of absolute.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function normalizeOptionalRegistryId(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const normalized = normalizeGlobalProjectId(value.trim());
  return normalized || undefined;
}

function normalizeOptionalProjectName(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  return value.trim();
}

function requireProjectName(value: unknown, name: string): string {
  const normalized = normalizeOptionalProjectName(value);
  if (!normalized) throw new Error(`${name} is required`);
  return normalized;
}

function normalizeTimeoutMs(args: VmExecArgs): number | undefined {
  if (typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)) {
    return Math.max(1, Math.floor(args.timeoutMs));
  }
  if (
    typeof args.timeoutSeconds === "number" &&
    Number.isFinite(args.timeoutSeconds)
  ) {
    return Math.max(1, Math.floor(args.timeoutSeconds * 1000));
  }
  return undefined;
}

function normalizeStringMap(value: unknown): Record<string, string | undefined> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("env must be an object");
  }
  const output: Record<string, string | undefined> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid environment variable name: ${key}`);
    }
    if (entry === undefined || entry === null) {
      output[key] = undefined;
    } else if (typeof entry === "string") {
      output[key] = entry;
    } else {
      throw new Error(`Environment variable ${key} must be a string`);
    }
  }
  return output;
}

function joinAbsolutePath(root: string, child: string): string {
  const cleanRoot = normalizeAbsolutePath(root);
  const cleanChild = child.replace(/^\/+/, "");
  return normalizeAbsolutePath(`${cleanRoot}/${cleanChild}`);
}

function relativeUnderRoot(root: string, path: string): string {
  const cleanRoot = normalizeAbsolutePath(root);
  const cleanPath = normalizeAbsolutePath(path);
  if (cleanPath === cleanRoot) return cleanPath.slice(cleanPath.lastIndexOf("/") + 1);
  const prefix = cleanRoot.endsWith("/") ? cleanRoot : `${cleanRoot}/`;
  if (cleanPath.startsWith(prefix)) return cleanPath.slice(prefix.length);
  return cleanPath.replace(/^\/+/, "");
}

function basenamePath(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}


function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function formatSize(value: number): string {
  if (value < 1024) return `${value}B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`;
  return `${(value / (1024 * 1024)).toFixed(1)}MB`;
}

function projectVmImageResult({
  target,
  path,
  size,
  imageMimeType,
  prepared,
}: {
  target: Record<string, string>;
  path: string;
  size: number | null;
  imageMimeType: string;
  prepared: PreparedInlineImage | null;
}) {
  let text = `Read image file [${prepared?.mimeType ?? imageMimeType}]\n[Image: ${path}${typeof size === "number" ? ` (${formatSize(size)})` : ""}]`;
  if (prepared?.optimizedForInlineView) {
    text += `\n[Image optimized for inline model context and may be scaled/compressed from the source.]`;
  }
  const content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [
    { type: "text", text },
  ];
  if (prepared) {
    content.push({ type: "image", data: prepared.data, mimeType: prepared.mimeType });
  } else {
    text += `\n[Image omitted: could not be resized below the inline image size limit of ${inlineImageMaxBase64Chars()} base64 chars.]`;
    content[0] = { type: "text", text };
  }
  return {
    text,
    content,
    details: {
      provider: PROJECT_RUNTIME_PROVIDER,
      target,
      path,
      size,
      image: true,
      mimeType: prepared?.mimeType ?? imageMimeType,
      originalMimeType: imageMimeType,
      inlineImage: Boolean(prepared),
      optimizedForInlineView: prepared?.optimizedForInlineView ?? false,
      maxInlineDimension: prepared?.maxInlineDimension ?? null,
      usedImagesBinding: prepared?.usedImagesBinding ?? false,
      base64Chars: prepared?.base64Chars ?? null,
      encoding: "base64",
    },
  };
}

function isLikelyBinary(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return true;
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length === 0) return false;
  let printable = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 32 && byte <= 126)) {
      printable += 1;
    }
  }
  return printable / sample.length < 0.85;
}

function vmTextResult(text: string, details?: Record<string, unknown>) {
  return {
    text,
    content: [{ type: "text", text }],
    ...(details && Object.keys(details).length > 0 ? { details } : {}),
  };
}

function normalizeEdits(value: unknown): Array<{ oldText: string; newText: string }> {
  if (!Array.isArray(value)) return [];
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object") {
      throw new Error(`edits[${index}] must be an object`);
    }
    const record = entry as Record<string, unknown>;
    const oldText = typeof record.oldText === "string"
      ? record.oldText
      : typeof record.old_string === "string"
        ? record.old_string
        : "";
    const newText = typeof record.newText === "string"
      ? record.newText
      : typeof record.new_string === "string"
        ? record.new_string
        : "";
    if (!oldText) throw new Error(`edits[${index}].oldText is required`);
    return { oldText, newText };
  });
}

function applyExactEdits(text: string, edits: Array<{ oldText: string; newText: string }>, path: string): string {
  let output = text;
  for (const edit of edits) {
    const first = output.indexOf(edit.oldText);
    if (first < 0) {
      throw new Error(`Edit target not found in ${path}: ${edit.oldText.slice(0, 80)}`);
    }
    if (output.indexOf(edit.oldText, first + edit.oldText.length) >= 0) {
      throw new Error(`Edit target is not unique in ${path}: ${edit.oldText.slice(0, 80)}`);
    }
    output = output.slice(0, first) + edit.newText + output.slice(first + edit.oldText.length);
  }
  return output;
}

function firstChangedLine(before: string, after: string): number | undefined {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  const limit = Math.max(beforeLines.length, afterLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (beforeLines[index] !== afterLines[index]) return index + 1;
  }
  return undefined;
}

function readErrorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (typeof record.message === "string") return record.message;
  }
  return "";
}
