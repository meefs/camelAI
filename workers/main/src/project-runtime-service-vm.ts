import type {
  ProjectVmEnv,
  VmCloneProjectArgs,
  VmExecArgs,
  VmFileArgs,
  VmPullArgs,
  VmPushArgs,
} from "./project-vm-protocol";
import {
  normalizeGlobalProjectId,
  projectRuntimeDeployProxyUrl,
  PROJECT_RUNTIME_PROVIDER,
  PROJECT_VM_CHECKOUT_PATH,
  runtimeArtifactsProxyRemote,
} from "./project-vm-protocol";
import {
  normalizeWorkspacePath as normalizeDurableWorkspacePath,
  type WorkspaceProject,
  type WorkspaceFilesystemLike,
} from "./workspace-filesystem-do";

const WORKSPACE_ROOT = "/";
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

  async push(args: VmPushArgs): Promise<unknown> {
    const paths = normalizeStringArray(args.paths, "paths");
    const target = await this.getReadyTarget(args);
    const vmRoot = typeof args.vmRoot === "string" && args.vmRoot.trim()
      ? this.resolveVmToolPath(args.vmRoot, target)
      : target.projectRoot;

    if (args.clean === true) {
      await this.mustExec(target, `rm -rf ${shellQuote(vmRoot)} && mkdir -p ${shellQuote(vmRoot)}`);
    } else {
      await this.mkdir(target, vmRoot);
    }

    const files = await this.collectWorkspaceFiles(paths);
    let bytes = 0;
    for (const file of files) {
      const read = await this.options.workspace.readFile(file.absolutePath);
      if (!read.success || typeof read.content !== "string") {
        throw new Error(read.error || `Failed to read ${file.absolutePath}`);
      }
      const base64Content =
        read.encoding === "base64"
          ? read.content
          : bytesToBase64(new TextEncoder().encode(read.content));
      bytes += base64ByteLength(base64Content);
      const vmPath = joinAbsolutePath(vmRoot, file.relativePath);
      await this.writeBytes(target, vmPath, base64ToBytes(base64Content));
    }

    return {
      success: true,
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      vmRoot,
      files: files.length,
      bytes,
    };
  }

  async pull(args: VmPullArgs): Promise<unknown> {
    const target = await this.getReadyTarget(args);
    const vmRoot = typeof args.vmRoot === "string" && args.vmRoot.trim()
      ? this.resolveVmToolPath(args.vmRoot, target)
      : target.projectRoot;
    const workspaceRoot = typeof args.workspaceRoot === "string" && args.workspaceRoot.trim()
      ? normalizeWorkspacePath(args.workspaceRoot)
      : WORKSPACE_ROOT;

    const mappings = normalizeVmFileMappings(args.files);
    const paths = normalizeOptionalStringArray(args.paths, "paths").map((path) =>
      this.resolveVmToolPath(path, target, target.projectRoot),
    );
    if (paths.length > 0) {
      for (const vmPath of await this.listVmFiles(paths, target)) {
        mappings.push({
          vmPath,
          workspacePath: joinAbsolutePath(
            workspaceRoot,
            relativeUnderRoot(vmRoot, vmPath),
          ),
        });
      }
    }
    if (mappings.length === 0) {
      throw new Error("Provide paths or files to pull from the VM");
    }

    let bytes = 0;
    const written: Array<{ vmPath: string; workspacePath: string; bytes: number }> = [];
    for (const mapping of mappings) {
      const response = await this.fetchRuntime(
        this.projectUrl(target.projectId, "/fs/read", { path: mapping.vmPath }),
      );
      if (!response.ok) {
        throw new Error((await response.text()) || `Failed to read ${mapping.vmPath}`);
      }
      const content = bytesToBase64(new Uint8Array(await response.arrayBuffer()));
      const result = await this.options.workspace.writeBinaryFile(
        normalizeWorkspacePath(mapping.workspacePath),
        content,
      );
      if (!result.success) {
        throw new Error(result.error || `Failed to write ${mapping.workspacePath}`);
      }
      const size = base64ByteLength(content);
      bytes += size;
      written.push({ ...mapping, bytes: size });
    }

    return {
      success: true,
      provider: PROJECT_RUNTIME_PROVIDER,
      target: target.summary,
      files: written.length,
      bytes,
      written,
    };
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
    const bytes = new Uint8Array(await response.arrayBuffer());
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
      throw new Error(`${project.name} does not have a ready Artifacts remote`);
    }

    const branch = project.artifactDefaultBranch || "main";
    const remoteProjectId = project.artifactRemoteProjectId || project.id;
    const remote = project.artifactRemote
      ? runtimeArtifactsProxyRemote(
          this.options.env.PROJECT_RUNTIME_ARTIFACTS_PROXY_BASE,
          this.options.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL,
          project.id,
          remoteProjectId,
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

  private async mkdir(target: ProjectRuntimeTarget, path: string): Promise<void> {
    const response = await this.fetchRuntime(this.projectUrl(target.projectId, "/fs/mkdir", { path }), {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error((await response.text()) || `Failed to create directory ${path}`);
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
    env.CLOUDFLARE_API_BASE_URL = this.deployDockerProxyUrl();
    env.CLOUDFLARE_API_TOKEN ||= "project-runtime-proxy";
    return Object.keys(env).length > 0 ? env : undefined;
  }

  private deployDockerProxyUrl(): string {
    return projectRuntimeDeployProxyUrl(this.options.env.PROJECT_RUNTIME_DOCKER_PROXY_BASE_URL);
  }

  private async collectWorkspaceFiles(paths: string[]): Promise<Array<{ absolutePath: string; relativePath: string; size?: number }>> {
    const files: Array<{ absolutePath: string; relativePath: string; size?: number }> = [];
    const seen = new Set<string>();

    for (const rawPath of paths) {
      const absolutePath = normalizeWorkspacePath(rawPath);
      const exists = await this.options.workspace.exists(absolutePath);
      if (!exists.exists) throw new Error(`Workspace path not found: ${rawPath}`);

      if (exists.isDirectory) {
        const listing = await this.options.workspace.listFiles(absolutePath, {
          recursive: true,
          includeHidden: true,
        });
        if (listing.success === false) {
          throw new Error(listing.error || `Failed to list ${absolutePath}`);
        }
        for (const entry of listing.files) {
          if (entry.type !== "file") continue;
          const entryAbsolutePath = normalizeWorkspacePath(
            entry.absolutePath || joinAbsolutePath(absolutePath, entry.relativePath),
          );
          if (seen.has(entryAbsolutePath)) continue;
          seen.add(entryAbsolutePath);
          files.push({
            absolutePath: entryAbsolutePath,
            relativePath: relativeUnderRoot(WORKSPACE_ROOT, entryAbsolutePath),
            size: entry.size,
          });
        }
        continue;
      }

      if (!exists.isFile) continue;
      if (seen.has(absolutePath)) continue;
      seen.add(absolutePath);
      files.push({
        absolutePath,
        relativePath: relativeUnderRoot(WORKSPACE_ROOT, absolutePath),
        size: exists.size,
      });
    }

    files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    return files;
  }
}

function normalizeWorkspacePath(path: string): string {
  return normalizeDurableWorkspacePath(path);
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

function normalizeStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error(`${name} entries must be non-empty strings`);
    }
    return entry.trim();
  });
}

function normalizeOptionalStringArray(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return [];
  return normalizeStringArray(value, name);
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

function normalizeVmFileMappings(value: unknown): Array<{ vmPath: string; workspacePath: string }> {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("files must be an array");
  return value.map((entry) => {
    if (!entry || typeof entry !== "object") {
      throw new Error("files entries must be objects");
    }
    const record = entry as Record<string, unknown>;
    if (typeof record.vmPath !== "string" || typeof record.workspacePath !== "string") {
      throw new Error("files entries require vmPath and workspacePath");
    }
    return {
      vmPath: normalizeVmPath(record.vmPath),
      workspacePath: normalizeWorkspacePath(record.workspacePath),
    };
  });
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, "");
  if (!normalized) return 0;
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  return Math.floor((normalized.length * 3) / 4) - padding;
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
