import { DurableObject } from "cloudflare:workers";
import { Workspace, type FileInfo } from "@cloudflare/shell";
import { normalizeGlobalProjectId } from "./project-vm-protocol.js";

const LEGACY_WORKSPACE_ROOT = "/home/claude";
const WORKSPACE_ROOT_ALIASES = [LEGACY_WORKSPACE_ROOT, "/workspace"];
const DEFAULT_INLINE_THRESHOLD = 1_500_000;

export interface WorkspaceFilesystemEnv {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  ARTIFACTS?: ArtifactsBinding;
  CF_ACCOUNT_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
}

export interface WorkspaceReadFileResponse {
  success: boolean;
  content?: string;
  size?: number;
  isBinary?: boolean;
  encoding?: "utf8" | "base64";
  mimeType?: string;
  error?: string;
  code?: string;
}

export interface WorkspaceReadFileStreamResponse {
  success: boolean;
  stream?: ReadableStream<Uint8Array>;
  size?: number;
  mimeType?: string;
  error?: string;
  code?: string;
}

export interface WorkspaceWriteResponse {
  success: boolean;
  error?: string;
  code?: string;
}

export interface WorkspaceExistsResponse {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  mimeType?: string;
}

export interface WorkspaceListEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  relativePath: string;
  absolutePath: string;
  mimeType?: string;
}

export interface WorkspaceListResponse {
  success: boolean;
  files: WorkspaceListEntry[];
  count: number;
  path: string;
  timestamp?: string;
  error?: string;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  description: string;
  defaultVmId: string;
  backend?: WorkspaceProjectBackend;
  kind?: "project" | "clone";
  clonedFromProjectId?: string;
  cloneSource?: WorkspaceProjectCloneSource;
  clones?: WorkspaceProjectCloneSummary[];
  cloneCount?: number;
  artifactRemoteProjectId?: string;
  artifactRepoName?: string;
  artifactRepoId?: string;
  artifactRemote?: string;
  artifactDefaultBranch?: string;
  artifactStatus?: "ready" | "creating" | "importing" | "forking" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProjectCloneSource {
  id: string;
  name: string;
  description: string;
}

export interface WorkspaceProjectCloneSummary {
  id: string;
  name: string;
  description: string;
  defaultVmId: string;
  backend?: WorkspaceProjectBackend;
  clonedFromProjectId: string;
  artifactRemote?: string;
  artifactStatus?: WorkspaceProject["artifactStatus"];
  createdAt: string;
  updatedAt: string;
}

export type WorkspaceProjectBackend = "vm" | "do-r2";

export interface WorkspaceFilesystemLike {
  exists(path: string): Promise<WorkspaceExistsResponse>;
  readFile(path: string): Promise<WorkspaceReadFileResponse>;
  readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse>;
  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse>;
  writeBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse>;
  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean; limit?: number },
  ): Promise<WorkspaceListResponse>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<WorkspaceWriteResponse>;
  deleteFile(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<WorkspaceWriteResponse>;
  listProjects(): Promise<WorkspaceProject[]>;
  listProjectsForMigrationReset(): Promise<WorkspaceProject[]>;
  getProject(projectId: unknown): Promise<WorkspaceProject | null>;
  getProjectByName(project: unknown): Promise<WorkspaceProject | null>;
  deleteProjectsForWorkspace(workspaceId?: unknown): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }>;
  removeProjects(projectIds: string[]): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }>;
  createProject(input?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    backend?: unknown;
  }): Promise<WorkspaceProject>;
  setProjectDescription(input?: { project?: unknown; projectId?: unknown; description?: unknown }): Promise<WorkspaceProject>;
  setProjectBackend(input?: { project?: unknown; projectId?: unknown; backend?: unknown }): Promise<WorkspaceProject>;
  cloneProject(input?: {
    sourceProject?: unknown;
    sourceProjectId?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject>;
  mintProjectArtifactToken(
    projectId: unknown,
    scope?: "read" | "write",
    ttlSeconds?: number,
  ): Promise<ProjectArtifactToken>;
}

export type WorkspaceFileStoreLike = Pick<WorkspaceFilesystemLike,
  | "exists"
  | "readFile"
  | "readFileStream"
  | "writeFile"
  | "writeBinaryFile"
  | "listFiles"
  | "mkdir"
  | "deleteFile"
>;

export interface ProjectArtifactToken {
  project: WorkspaceProject;
  token: string;
  expiresAt?: string | number;
  artifactRemote: string;
  artifactRemoteProjectId: string;
}

export interface ProjectSourceSnapshotEntry {
  path: string;
  size: number;
  sha256: string;
  blobKey: string;
}

export interface ProjectSourceSnapshot {
  id: string;
  createdAt: string;
  message?: string;
  fileCount: number;
  totalBytes: number;
  entries: ProjectSourceSnapshotEntry[];
}

const PROJECTS_KEY = "projects:v1";
const PROJECT_SNAPSHOT_INDEX_KEY = "project-source-snapshots:v1";
const PROJECT_SNAPSHOT_PREFIX = "project-source-snapshot:";
const DEFAULT_PROJECT_VM_ID = "main";
const ARTIFACTS_DEFAULT_BRANCH = "main";
const ARTIFACTS_READY_TIMEOUT_MS = 30_000;
const ARTIFACTS_READY_POLL_MS = 1_000;
export const ARTIFACTS_VANITY_HOST = "artifacts.camelai.internal";
type FileStoreScope = "workspace" | "project";

interface ArtifactsBinding {
  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
}

interface ArtifactsRepoInfo {
  id?: string;
  name: string;
  remote?: string;
  defaultBranch?: string;
  status?: "ready" | "creating" | "importing" | "forking";
}

interface ArtifactsCreateRepoResult extends ArtifactsRepoInfo {
  token?: string;
}

interface ArtifactsCreateTokenResult {
  plaintext: string;
  expiresAt?: string | number;
}

export interface ArtifactsRepo extends ArtifactsRepoInfo {
  createToken(scope?: "read" | "write", ttl?: number): Promise<ArtifactsCreateTokenResult>;
}

interface ReadyArtifactsRepoInfo extends ArtifactsRepoInfo {
  remote: string;
}

export class WorkspaceFilesystemDO extends DurableObject<WorkspaceFilesystemEnv> {
  private workspaceFiles?: Workspace;
  private projectFiles?: Workspace;

  constructor(ctx: DurableObjectState, env: WorkspaceFilesystemEnv) {
    super(ctx, env);
  }

  private get workspace(): Workspace {
    this.workspaceFiles ??= this.createFileStore("workspace");
    return this.workspaceFiles;
  }

  private get projectWorkspace(): Workspace {
    this.projectFiles ??= this.createFileStore("project");
    return this.projectFiles;
  }

  private createFileStore(scope: FileStoreScope): Workspace {
    const durableId = this.ctx.id.toString();
    return new Workspace({
      sql: this.ctx.storage.sql,
      r2: this.env.R2_BUCKET,
      r2Prefix: fileStoreR2Prefix(scope, durableId),
      inlineThreshold: DEFAULT_INLINE_THRESHOLD,
      name: durableId,
    });
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async exists(path: string): Promise<WorkspaceExistsResponse> {
    return this.existsIn(this.workspace, path);
  }

  async projectExists(path: string): Promise<WorkspaceExistsResponse> {
    return this.existsIn(this.projectWorkspace, path);
  }

  private async existsIn(files: Workspace, path: string): Promise<WorkspaceExistsResponse> {
    const stat = await files.stat(normalizeWorkspacePath(path));
    if (!stat) return { exists: false };
    return {
      exists: true,
      isFile: stat.type === "file",
      isDirectory: stat.type === "directory",
      size: stat.size,
      mimeType: stat.mimeType,
    };
  }

  async readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.readFileFrom(this.workspace, path);
  }

  async projectReadFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.readFileFrom(this.projectWorkspace, path);
  }

  private async readFileFrom(files: Workspace, path: string): Promise<WorkspaceReadFileResponse> {
    const normalizedPath = normalizeWorkspacePath(path);
    const bytes = await files.readFileBytes(normalizedPath);
    if (!bytes) {
      return { success: false, error: "File not found", code: "ENOENT" };
    }
    const stat = await files.stat(normalizedPath);
    const decoded = decodeMaybeText(bytes);
    return {
      success: true,
      content: decoded.content,
      size: bytes.byteLength,
      isBinary: decoded.isBinary,
      encoding: decoded.isBinary ? "base64" : "utf8",
      mimeType: stat?.mimeType,
    };
  }

  async readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.readFileStreamFrom(this.workspace, path);
  }

  async projectReadFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.readFileStreamFrom(this.projectWorkspace, path);
  }

  private async readFileStreamFrom(files: Workspace, path: string): Promise<WorkspaceReadFileStreamResponse> {
    const normalizedPath = normalizeWorkspacePath(path);
    const stream = await files.readFileStream(normalizedPath);
    if (!stream) {
      return { success: false, error: "File not found", code: "ENOENT" };
    }
    const stat = await files.stat(normalizedPath);
    return {
      success: true,
      stream,
      size: stat?.size,
      mimeType: stat?.mimeType,
    };
  }

  async writeFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    return this.writeFileTo(this.workspace, path, content);
  }

  async projectWriteFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    return this.writeFileTo(this.projectWorkspace, path, content);
  }

  private async writeFileTo(files: Workspace, path: string, content: string): Promise<WorkspaceWriteResponse> {
    try {
      await files.writeFile(normalizeWorkspacePath(path), content);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EWRITE" };
    }
  }

  async writeBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse> {
    return this.writeBinaryFileTo(this.workspace, path, base64Content);
  }

  async projectWriteBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse> {
    return this.writeBinaryFileTo(this.projectWorkspace, path, base64Content);
  }

  private async writeBinaryFileTo(files: Workspace, path: string, base64Content: string): Promise<WorkspaceWriteResponse> {
    try {
      await files.writeFileBytes(
        normalizeWorkspacePath(path),
        base64ToBytes(base64Content),
      );
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EWRITE" };
    }
  }

  async listFiles(
    path: string,
    options: { recursive?: boolean; includeHidden?: boolean; limit?: number } = {},
  ): Promise<WorkspaceListResponse> {
    return this.listFilesFrom(this.workspace, path, options);
  }

  async projectListFiles(
    path: string,
    options: { recursive?: boolean; includeHidden?: boolean; limit?: number } = {},
  ): Promise<WorkspaceListResponse> {
    return this.listFilesFrom(this.projectWorkspace, path, options);
  }

  private async listFilesFrom(
    filesStore: Workspace,
    path: string,
    options: { recursive?: boolean; includeHidden?: boolean; limit?: number } = {},
  ): Promise<WorkspaceListResponse> {
    const root = normalizeWorkspacePath(path);
    const includeHidden = options.includeHidden === true;
    const limit = Math.max(1, Math.min(50_000, Math.floor(options.limit ?? 10_000)));

    try {
      const stat = await filesStore.stat(root);
      if (!stat) throw new Error(`Path not found: ${root}`);
      const files: WorkspaceListEntry[] = [];
      if (stat.type === "file") {
        files.push(toListEntry(stat, root, root));
      } else {
        await this.collectEntries(filesStore, root, root, files, {
          recursive: options.recursive === true,
          includeHidden,
          limit,
        });
      }
      return {
        success: true,
        files,
        count: files.length,
        path: root,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        files: [],
        count: 0,
        path: root,
        error: errorMessage(error),
      };
    }
  }

  async mkdir(path: string, options: { recursive?: boolean } = {}): Promise<WorkspaceWriteResponse> {
    return this.mkdirIn(this.workspace, path, options);
  }

  async projectMkdir(path: string, options: { recursive?: boolean } = {}): Promise<WorkspaceWriteResponse> {
    return this.mkdirIn(this.projectWorkspace, path, options);
  }

  private async mkdirIn(files: Workspace, path: string, options: { recursive?: boolean } = {}): Promise<WorkspaceWriteResponse> {
    try {
      await files.mkdir(normalizeWorkspacePath(path), { recursive: options.recursive === true });
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EMKDIR" };
    }
  }

  async deleteFile(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    return this.deleteFileFrom(this.workspace, path, options);
  }

  async projectDeleteFile(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    return this.deleteFileFrom(this.projectWorkspace, path, options);
  }

  private async deleteFileFrom(
    files: Workspace,
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    try {
      await files.rm(normalizeWorkspacePath(path), {
        recursive: options.recursive === true,
        force: options.force === true,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EDELETE" };
    }
  }

  async projectCreateSourceSnapshot(input: { message?: unknown } = {}): Promise<ProjectSourceSnapshot> {
    const message = typeof input.message === "string" && input.message.trim()
      ? input.message.trim().slice(0, 240)
      : undefined;
    const listing = await this.projectListFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
    if (!listing.success) throw new Error(listing.error || "Failed to list project files");

    const entries: ProjectSourceSnapshotEntry[] = [];
    let totalBytes = 0;
    for (const entry of listing.files) {
      if (entry.type !== "file") continue;
      const path = normalizeProjectSnapshotPath(entry.absolutePath);
      if (!path || shouldIgnoreProjectSnapshotPath(path)) continue;
      const bytes = await this.projectWorkspace.readFileBytes(`/${path}`);
      if (!bytes) continue;
      const sha256 = await sha256Hex(bytes);
      const blobKey = projectSnapshotBlobKey(this.ctx.id.toString(), sha256);
      const existingBlob = await this.env.R2_BUCKET.head(blobKey);
      if (!existingBlob) {
        await this.env.R2_BUCKET.put(blobKey, bytes, {
          customMetadata: { type: "project-source-snapshot", sha256 },
        });
      }
      entries.push({ path, size: bytes.byteLength, sha256, blobKey });
      totalBytes += bytes.byteLength;
    }
    entries.sort((a, b) => a.path.localeCompare(b.path));
    const digestInput = JSON.stringify(entries.map((entry) => [entry.path, entry.size, entry.sha256]));
    const id = await sha256Hex(new TextEncoder().encode(digestInput));
    const snapshot: ProjectSourceSnapshot = {
      id,
      createdAt: new Date().toISOString(),
      ...(message ? { message } : {}),
      fileCount: entries.length,
      totalBytes,
      entries,
    };
    await this.ctx.storage.kv.put(`${PROJECT_SNAPSHOT_PREFIX}${id}`, snapshot);
    const index = await this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_INDEX_KEY) ?? [];
    await this.ctx.storage.kv.put(PROJECT_SNAPSHOT_INDEX_KEY, [id, ...index.filter((existing) => existing !== id)].slice(0, 200));
    return snapshot;
  }

  async projectRestoreSourceSnapshot(snapshotId: unknown): Promise<ProjectSourceSnapshot> {
    const id = requireSnapshotId(snapshotId);
    const snapshot = await this.ctx.storage.kv.get<ProjectSourceSnapshot>(`${PROJECT_SNAPSHOT_PREFIX}${id}`);
    if (!snapshot) throw new Error(`Project source snapshot not found: ${id}`);
    const keep = new Set(snapshot.entries.map((entry) => entry.path));
    const current = await this.projectListFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
    if (!current.success) throw new Error(current.error || "Failed to list project files");
    for (const entry of current.files) {
      if (entry.type !== "file") continue;
      const path = normalizeProjectSnapshotPath(entry.absolutePath);
      if (!path || shouldIgnoreProjectSnapshotPath(path) || keep.has(path)) continue;
      await this.projectWorkspace.rm(`/${path}`, { force: true });
    }
    for (const entry of snapshot.entries) {
      const object = await this.env.R2_BUCKET.get(entry.blobKey);
      if (!object) throw new Error(`Project source snapshot blob missing: ${entry.path}`);
      const bytes = new Uint8Array(await object.arrayBuffer());
      const actualSha = await sha256Hex(bytes);
      if (actualSha !== entry.sha256) throw new Error(`Project source snapshot blob hash mismatch: ${entry.path}`);
      await this.projectWorkspace.writeFileBytes(`/${entry.path}`, bytes);
    }
    return snapshot;
  }

  async projectListSourceSnapshots(limit = 20): Promise<ProjectSourceSnapshot[]> {
    const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    const index = await this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_INDEX_KEY) ?? [];
    const snapshots: ProjectSourceSnapshot[] = [];
    for (const id of index.slice(0, safeLimit)) {
      const snapshot = await this.ctx.storage.kv.get<ProjectSourceSnapshot>(`${PROJECT_SNAPSHOT_PREFIX}${id}`);
      if (snapshot) snapshots.push(snapshot);
    }
    return snapshots;
  }

  async projectDeleteSourceSnapshots(): Promise<{ snapshotsDeleted: number; blobsDeleted: number }> {
    const index = await this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_INDEX_KEY) ?? [];
    const blobKeys = new Set<string>();
    let snapshotsDeleted = 0;
    for (const id of index) {
      const snapshot = await this.ctx.storage.kv.get<ProjectSourceSnapshot>(`${PROJECT_SNAPSHOT_PREFIX}${id}`);
      if (!snapshot) continue;
      snapshotsDeleted += 1;
      for (const entry of snapshot.entries) {
        if (entry.blobKey) blobKeys.add(entry.blobKey);
      }
      await this.ctx.storage.kv.delete(`${PROJECT_SNAPSHOT_PREFIX}${id}`);
    }
    await this.ctx.storage.kv.put(PROJECT_SNAPSHOT_INDEX_KEY, []);
    let blobsDeleted = 0;
    for (const key of blobKeys) {
      await this.env.R2_BUCKET.delete(key);
      blobsDeleted += 1;
    }
    return { snapshotsDeleted, blobsDeleted };
  }

  async listProjects(): Promise<WorkspaceProject[]> {
    return nestProjectClones((await this.readProjects()).map(toPublicProject));
  }

  // Flat project list (clones not nested under their source). Used by the
  // project delete paths to resolve targets by id/name.
  async listProjectsForMigrationReset(): Promise<WorkspaceProject[]> {
    return (await this.readProjects()).map(toPublicProject);
  }

  async getProject(projectId: unknown): Promise<WorkspaceProject | null> {
    const id = requireProjectId(projectId, "project");
    const project = (await this.readProjects()).find((candidate) => candidate.id === id);
    return project ? toPublicProject(await this.ensureProjectArtifactsReady(project)) : null;
  }

  async getProjectByName(project: unknown): Promise<WorkspaceProject | null> {
    const nameKey = requireProjectNameKey(project, "project");
    const existing = (await this.readProjects()).find((candidate) => projectNameKey(candidate.name) === nameKey);
    return existing ? toPublicProject(await this.ensureProjectArtifactsReady(existing)) : null;
  }

  async deleteProjectsForWorkspace(workspaceId: unknown = this.ctx.id.toString()): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    requireWorkspaceId(workspaceId);
    const projects = await this.readProjects();
    if (projects.length > 0) {
      await this.ctx.storage.kv.put(PROJECTS_KEY, []);
    }

    return {
      deleted: projects.map(toPublicProject),
      retained: [],
    };
  }

  async removeProjects(projectIds: string[]): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    const idSet = new Set(
      projectIds
        .map((projectId) => (typeof projectId === "string" ? projectId.trim() : ""))
        .filter(Boolean),
    );
    if (idSet.size === 0) {
      return { deleted: [], retained: (await this.readProjects()).map(toPublicProject) };
    }
    const projects = await this.readProjects();
    const deleted = projects.filter((project) => idSet.has(project.id));
    const retained = projects.filter((project) => !idSet.has(project.id));
    if (deleted.length > 0) {
      await this.ctx.storage.kv.put(PROJECTS_KEY, retained);
    }
    return {
      deleted: deleted.map(toPublicProject),
      retained: retained.map(toPublicProject),
    };
  }

  async createProject(input: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    workspaceId?: unknown;
    backend?: unknown;
  } = {}): Promise<WorkspaceProject> {
    const projects = await this.readProjects();
    const name = requireProjectName(input.name ?? input.id ?? `project-${projects.length + 1}`);
    const nameKey = projectNameKey(name);
    if (projects.some((project) => projectNameKey(project.name) === nameKey)) {
      throw new Error(`Project already exists: ${name}`);
    }
    const workspaceId = requireWorkspaceId(input.workspaceId);
    const id = globalProjectId(workspaceId, input.id ?? name);
    if (projects.some((project) => project.id === id)) {
      throw new Error(`Project already exists: ${name}`);
    }

    const now = new Date().toISOString();
    const description = requireProjectDescription(input.description);
    const backend = input.backend === undefined ? "vm" : requireProjectBackend(input.backend);
    const project = await this.ensureProjectArtifactRepo({
      id,
      name,
      description,
      defaultVmId: DEFAULT_PROJECT_VM_ID,
      backend,
      createdAt: now,
      updatedAt: now,
    });
    projects.push(project);
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(project);
  }

  async setProjectDescription(input: { project?: unknown; projectId?: unknown; description?: unknown } = {}): Promise<WorkspaceProject> {
    const projectName = input.project;
    const description = requireProjectDescription(input.description);
    const projects = await this.readProjects();
    const index = typeof projectName === "string" && projectName.trim()
      ? projects.findIndex((project) => projectNameKey(project.name) === requireProjectNameKey(projectName, "project"))
      : projects.findIndex((project) => project.id === requireProjectId(input.projectId, "project"));
    if (index === -1) {
      throw new Error(`Project not found: ${String(projectName || input.projectId || "")}`);
    }
    const updated: WorkspaceProject = {
      ...projects[index]!,
      description,
      updatedAt: new Date().toISOString(),
    };
    projects[index] = updated;
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(updated);
  }

  async setProjectBackend(input: { project?: unknown; projectId?: unknown; backend?: unknown } = {}): Promise<WorkspaceProject> {
    const backend = requireProjectBackend(input.backend);
    const projects = await this.readProjects();
    const index = typeof input.project === "string" && input.project.trim()
      ? projects.findIndex((project) => projectNameKey(project.name) === requireProjectNameKey(input.project, "project"))
      : projects.findIndex((project) => project.id === requireProjectId(input.projectId, "project"));
    if (index === -1) {
      throw new Error(`Project not found: ${String(input.project || input.projectId || "")}`);
    }
    const updated: WorkspaceProject = {
      ...projects[index]!,
      backend,
      updatedAt: new Date().toISOString(),
    };
    projects[index] = updated;
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(updated);
  }

  async cloneProject(input: {
    sourceProject?: unknown;
    sourceProjectId?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
    workspaceId?: unknown;
  } = {}): Promise<WorkspaceProject> {
    const initialProjects = await this.readProjects();
    const sourceName = input.sourceProject;
    const existingSource = typeof sourceName === "string" && sourceName.trim()
      ? initialProjects.find((project) => projectNameKey(project.name) === requireProjectNameKey(sourceName, "source project"))
      : initialProjects.find((project) => project.id === requireProjectId(input.sourceProjectId, "source project"));
    if (!existingSource) {
      throw new Error(`Source project not found: ${String(sourceName || input.sourceProjectId || "")}`);
    }

    const source = existingSource.artifactRemote && existingSource.artifactStatus !== "error"
      ? existingSource
      : await this.ensureProjectArtifactRepo(existingSource);
    if (!source) {
      throw new Error(`Source project not found: ${String(sourceName || input.sourceProjectId || "")}`);
    }
    if (!source.artifactRepoName || source.artifactStatus === "error") {
      throw new Error(`Source project ${source.id} is not backed by an Artifacts repo`);
    }

    const projects = await this.readProjects();
    const cloneName = typeof input.name === "string" && input.name.trim()
      ? requireProjectName(input.name)
      : nextProjectCopyName(projects, source);
    const cloneNameKey = projectNameKey(cloneName);
    if (projects.some((project) => projectNameKey(project.name) === cloneNameKey)) {
      throw new Error(`Project already exists: ${cloneName}`);
    }
    const requestedId = input.id ?? cloneName;
    const workspaceId = requireWorkspaceId(input.workspaceId);
    const id = globalProjectId(workspaceId, requestedId);
    if (projects.some((project) => project.id === id)) {
      throw new Error(`Project already exists: ${cloneName}`);
    }

    const now = new Date().toISOString();
    const description = typeof input.description === "string" && input.description.trim()
      ? input.description.trim()
      : `Clone of ${source.name}: ${projectDescription(source)}`;
    const project: WorkspaceProject = {
      id,
      name: cloneName,
      description,
      defaultVmId: DEFAULT_PROJECT_VM_ID,
      backend: source.backend ?? "vm",
      clonedFromProjectId: source.id,
      artifactRemoteProjectId: source.artifactRemoteProjectId || source.id,
      artifactRepoName: source.artifactRepoName,
      artifactRepoId: source.artifactRepoId,
      artifactRemote: source.artifactRemote,
      artifactDefaultBranch: source.artifactDefaultBranch || ARTIFACTS_DEFAULT_BRANCH,
      artifactStatus: source.artifactStatus || "ready",
      createdAt: now,
      updatedAt: now,
    };
    projects.push(project);
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(project);
  }

  async mintProjectArtifactToken(
    projectId: unknown,
    scope: "read" | "write" = "write",
    ttlSeconds = 600,
  ): Promise<ProjectArtifactToken> {
    const id = requireProjectId(projectId, "project");
    const existing = (await this.readProjects()).find((candidate) => candidate.id === id);
    let project = existing ?? null;
    if (!project) {
      throw new Error(`Project not found: ${String(projectId)}`);
    }
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) {
      throw new Error("ARTIFACTS binding is not configured");
    }
    if (!project.artifactRepoName || !project.artifactRemote || project.artifactStatus === "error") {
      project = await this.ensureProjectArtifactRepo(project);
    }
    if (!project.artifactRepoName || !project.artifactRemote || project.artifactStatus === "error") {
      throw new Error(`Project ${project.id} is not backed by an Artifacts repo`);
    }
    let repo: ArtifactsRepo;
    try {
      repo = await artifacts.get(project.artifactRepoName);
    } catch {
      project = await this.ensureProjectArtifactRepo(project);
      if (!project.artifactRepoName || !project.artifactRemote || project.artifactStatus === "error") {
        throw new Error(`Project ${project.id} is not backed by an Artifacts repo`);
      }
      repo = await artifacts.get(project.artifactRepoName);
    }
    const result = await repo.createToken(scope, ttlSeconds);
    return {
      project: toPublicProject(project),
      token: result.plaintext,
      expiresAt: result.expiresAt,
      artifactRemote: project.artifactRemote,
      artifactRemoteProjectId: project.artifactRemoteProjectId || project.id,
    };
  }

  private async readProjects(): Promise<WorkspaceProject[]> {
    const value = await this.ctx.storage.kv.get<WorkspaceProject[]>(PROJECTS_KEY);
    return Array.isArray(value) ? value.filter(isWorkspaceProject) : [];
  }

  private async ensureProjectArtifactRepo(project: WorkspaceProject): Promise<WorkspaceProject> {
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) return project;

    const repoName = project.artifactRepoName || artifactRepoName(this.ctx.id.toString(), project.id);
    const artifactRemote = this.artifactRemoteForRepo(repoName);
    try {
      const repo = await createOrGetArtifactRepo(artifacts, repoName, project, artifactRemote);
      const updated: WorkspaceProject = {
        ...project,
        artifactRepoName: repo.name,
        artifactRepoId: repo.id,
        artifactRemote: repo.remote,
        artifactDefaultBranch: repo.defaultBranch || ARTIFACTS_DEFAULT_BRANCH,
        artifactStatus: repo.status || "ready",
        updatedAt: new Date().toISOString(),
      };
      await this.replaceProject(updated);
      return updated;
    } catch (error) {
      const message = errorMessage(error);
      if (isArtifactsBindingUnavailableError(message)) {
        const updated: WorkspaceProject = {
          ...project,
          artifactRepoName: repoName,
          artifactRemote,
          artifactRemoteProjectId: project.artifactRemoteProjectId || project.id,
          artifactDefaultBranch: project.artifactDefaultBranch || ARTIFACTS_DEFAULT_BRANCH,
          artifactStatus: "error",
          updatedAt: new Date().toISOString(),
        };
        await this.replaceProject(updated);
        console.warn("[WorkspaceFilesystemDO] Artifacts repo unavailable; continuing without repo", {
          projectId: project.id,
          repoName,
          error: message,
        });
        return updated;
      }
      console.error("[WorkspaceFilesystemDO] failed to ensure Artifacts repo", {
        projectId: project.id,
        repoName,
        error: message,
      });
      throw error;
    }
  }

  private artifactRemoteForRepo(repoName: string): string {
    const accountId = this.env.CF_ACCOUNT_ID?.trim();
    const namespace = this.env.ARTIFACTS_NAMESPACE?.trim();
    if (!accountId || !namespace) {
      return `https://artifacts.cloudflare.test/git/${encodeURIComponent(repoName)}.git`;
    }
    return `https://${accountId}.artifacts.cloudflare.net/git/${encodeURIComponent(namespace)}/${encodeURIComponent(repoName)}.git`;
  }

  private async ensureProjectArtifactsReady(project: WorkspaceProject): Promise<WorkspaceProject> {
    if (project.artifactRemote && project.artifactStatus !== "error") {
      return project;
    }
    return this.ensureProjectArtifactRepo(project);
  }

  private async replaceProject(project: WorkspaceProject): Promise<void> {
    const projects = await this.readProjects();
    const index = projects.findIndex((candidate) => candidate.id === project.id);
    if (index === -1) return;
    projects[index] = project;
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
  }

  private async collectEntries(
    filesStore: Workspace,
    root: string,
    dir: string,
    files: WorkspaceListEntry[],
    options: { recursive: boolean; includeHidden: boolean; limit: number },
  ): Promise<void> {
    if (files.length >= options.limit) return;
    const entries = await filesStore.readDir(dir, { limit: options.limit });
    for (const entry of entries) {
      if (files.length >= options.limit) return;
      const relativePath = relativeUnderRoot(root, entry.path);
      if (!options.includeHidden && isHiddenPath(relativePath)) continue;
      files.push(toListEntry(entry, root, entry.path));
      if (options.recursive && entry.type === "directory") {
        await this.collectEntries(filesStore, root, entry.path, files, options);
      }
    }
  }
}

export class WorkspaceFilesystemClient implements WorkspaceFilesystemLike {
  constructor(
    private readonly env: WorkspaceFilesystemEnv,
    private readonly workspaceId: string,
  ) {}

  private get stub(): DurableObjectStub<WorkspaceFilesystemDO> {
    return this.env.WORKSPACE_FS.get(this.env.WORKSPACE_FS.idFromName(this.workspaceId));
  }

  exists(path: string): Promise<WorkspaceExistsResponse> {
    return this.stub.exists(path);
  }

  readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.stub.readFile(path);
  }

  readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.stub.readFileStream(path);
  }

  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    return this.stub.writeFile(path, content);
  }

  writeBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse> {
    return this.stub.writeBinaryFile(path, base64Content);
  }

  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean; limit?: number },
  ): Promise<WorkspaceListResponse> {
    return this.stub.listFiles(path, options);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<WorkspaceWriteResponse> {
    return this.stub.mkdir(path, options);
  }

  deleteFile(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<WorkspaceWriteResponse> {
    return this.stub.deleteFile(path, options);
  }

  listProjects(): Promise<WorkspaceProject[]> {
    return this.stub.listProjects();
  }

  listProjectsForMigrationReset(): Promise<WorkspaceProject[]> {
    return this.stub.listProjectsForMigrationReset();
  }

  getProject(projectId: unknown): Promise<WorkspaceProject | null> {
    return this.stub.getProject(projectId);
  }

  getProjectByName(project: unknown): Promise<WorkspaceProject | null> {
    return this.stub.getProjectByName(project);
  }

  deleteProjectsForWorkspace(workspaceId: unknown = this.workspaceId): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    return this.stub.deleteProjectsForWorkspace(workspaceId);
  }

  removeProjects(projectIds: string[]): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    return this.stub.removeProjects(projectIds);
  }

  createProject(input?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    backend?: unknown;
  }): Promise<WorkspaceProject> {
    return this.stub.createProject({ ...input, workspaceId: this.workspaceId });
  }

  setProjectDescription(input?: { project?: unknown; projectId?: unknown; description?: unknown }): Promise<WorkspaceProject> {
    return this.stub.setProjectDescription(input);
  }

  setProjectBackend(input?: { project?: unknown; projectId?: unknown; backend?: unknown }): Promise<WorkspaceProject> {
    return this.stub.setProjectBackend(input);
  }

  cloneProject(input?: {
    sourceProject?: unknown;
    sourceProjectId?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject> {
    return this.stub.cloneProject({ ...input, workspaceId: this.workspaceId });
  }

  mintProjectArtifactToken(
    projectId: unknown,
    scope?: "read" | "write",
    ttlSeconds?: number,
  ): Promise<ProjectArtifactToken> {
    return this.stub.mintProjectArtifactToken(projectId, scope, ttlSeconds);
  }
}

export class ProjectFilesystemClient implements WorkspaceFileStoreLike {
  constructor(
    private readonly env: WorkspaceFilesystemEnv,
    private readonly projectId: string,
  ) {}

  private get stub(): DurableObjectStub<WorkspaceFilesystemDO> {
    const normalizedProjectId = normalizeGlobalProjectId(this.projectId);
    return this.env.WORKSPACE_FS.get(this.env.WORKSPACE_FS.idFromName(normalizedProjectId));
  }

  exists(path: string): Promise<WorkspaceExistsResponse> {
    return this.stub.projectExists(path);
  }

  readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.stub.projectReadFile(path);
  }

  readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.stub.projectReadFileStream(path);
  }

  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    return this.stub.projectWriteFile(path, content);
  }

  writeBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse> {
    return this.stub.projectWriteBinaryFile(path, base64Content);
  }

  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean; limit?: number },
  ): Promise<WorkspaceListResponse> {
    return this.stub.projectListFiles(path, options);
  }

  mkdir(path: string, options?: { recursive?: boolean }): Promise<WorkspaceWriteResponse> {
    return this.stub.projectMkdir(path, options);
  }

  deleteFile(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<WorkspaceWriteResponse> {
    return this.stub.projectDeleteFile(path, options);
  }

  createSourceSnapshot(input?: { message?: unknown }): Promise<ProjectSourceSnapshot> {
    return this.stub.projectCreateSourceSnapshot(input);
  }

  restoreSourceSnapshot(snapshotId: unknown): Promise<ProjectSourceSnapshot> {
    return this.stub.projectRestoreSourceSnapshot(snapshotId);
  }

  listSourceSnapshots(limit?: number): Promise<ProjectSourceSnapshot[]> {
    return this.stub.projectListSourceSnapshots(limit);
  }

  deleteSourceSnapshots(): Promise<{ snapshotsDeleted: number; blobsDeleted: number }> {
    return this.stub.projectDeleteSourceSnapshots();
  }
}

export function normalizeWorkspacePath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  let raw = value.trim().replace(/\\/g, "/");
  if (raw === "~" || WORKSPACE_ROOT_ALIASES.includes(raw)) return "/";
  if (raw.startsWith("~/")) raw = raw.slice(2);
  const rootAlias = WORKSPACE_ROOT_ALIASES.find((alias) => raw.startsWith(`${alias}/`));
  if (rootAlias) {
    raw = raw.slice(rootAlias.length + 1);
  }
  if (!raw.startsWith("/")) raw = `/${raw}`;

  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

function normalizeRegistryId(value: unknown, fallback: string): string {
  const raw = typeof value === "string" && value.trim() ? value.trim() : fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function requireRegistryId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return normalizeRegistryId(value, label.replace(/[^a-z0-9-]+/gi, "-").toLowerCase());
}

function requireProjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const id = normalizeGlobalProjectId(value.trim());
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function nextProjectCopyName(projects: WorkspaceProject[], source: WorkspaceProject): string {
  const base = `${source.name || source.id} copy`;
  const used = new Set(projects.map((project) => projectNameKey(project.name)));
  if (!used.has(projectNameKey(base))) return base;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(projectNameKey(candidate))) return candidate;
  }

  throw new Error(`Unable to allocate a clone name for ${source.name || source.id}`);
}

async function createOrGetArtifactRepo(
  artifacts: ArtifactsBinding,
  repoName: string,
  project: WorkspaceProject,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  try {
    const created = await artifacts.create(repoName, {
      description: `camelAI project ${project.id}`,
      readOnly: false,
      setDefaultBranch: ARTIFACTS_DEFAULT_BRANCH,
    });
    return normalizeArtifactCreateInfo(created, repoName, artifactRemote);
  } catch (error) {
    if (isArtifactRepoAlreadyExistsError(error)) {
      try {
        const repo = await artifacts.get(repoName);
        return await artifactRepoInfoFromHandle(repo, repoName, artifactRemote);
      } catch {
        return readyArtifactRepoInfo(repoName, artifactRemote);
      }
    }
    try {
      return await waitForArtifactRepoHandleReady(artifacts, repoName, artifactRemote);
    } catch {
      throw error;
    }
  }
}

async function waitForArtifactRepoHandleReady(
  artifacts: ArtifactsBinding,
  repoName: string,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  const deadline = Date.now() + ARTIFACTS_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const repo = await artifacts.get(repoName);
      return await artifactRepoInfoFromHandle(repo, repoName, artifactRemote);
    } catch {
      await delay(ARTIFACTS_READY_POLL_MS);
    }
  }

  throw new Error(`Artifacts repo ${repoName} was not ready within ${ARTIFACTS_READY_TIMEOUT_MS}ms.`);
}

async function artifactRepoInfoFromHandle(
  repo: ArtifactsRepo,
  repoName: string,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  return {
    id: await optionalStringValue(repo.id),
    name: repoName,
    remote: await optionalStringValue(repo.remote) || artifactRemote,
    defaultBranch: await optionalStringValue(repo.defaultBranch) || ARTIFACTS_DEFAULT_BRANCH,
    status: normalizeArtifactStatus(await optionalStringValue(repo.status)) || "ready",
  };
}

async function normalizeArtifactCreateInfo(
  repo: ArtifactsCreateRepoResult,
  repoName: string,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  return {
    id: await optionalStringValue(repo.id),
    name: repoName,
    remote: await optionalStringValue(repo.remote) || artifactRemote,
    defaultBranch: await optionalStringValue(repo.defaultBranch),
    status: normalizeArtifactStatus(await optionalStringValue(repo.status)) || "ready",
  };
}

function isArtifactRepoAlreadyExistsError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return message.includes("already exists") || message.includes("already_exist");
}

function readyArtifactRepoInfo(repoName: string, artifactRemote: string): ReadyArtifactsRepoInfo {
  return {
    name: repoName,
    remote: artifactRemote,
    defaultBranch: ARTIFACTS_DEFAULT_BRANCH,
    status: "ready",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileStoreR2Prefix(scope: FileStoreScope, durableId: string): string {
  return `${scope === "project" ? "project-fs" : "workspace-fs"}/${durableId}`;
}

async function optionalStringValue(value: unknown): Promise<string | undefined> {
  const resolved = await Promise.resolve(value);
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined;
}

function normalizeArtifactStatus(status: string | undefined): ArtifactsRepoInfo["status"] {
  return status === "ready" || status === "creating" || status === "importing" || status === "forking"
    ? status
    : undefined;
}

export const __testing = {
  createOrGetArtifactRepo,
  fileStoreR2Prefix,
  isArtifactsBindingUnavailableError,
};

function artifactRepoName(_workspaceKey: string, projectId: string): string {
  return normalizeGlobalProjectId(projectId).slice(0, 63);
}

export function artifactVanityRemote(projectId: string): string {
  const project = normalizeGlobalProjectId(projectId);
  return `https://${ARTIFACTS_VANITY_HOST}/git/${project}.git`;
}

function toPublicProject(project: WorkspaceProject): WorkspaceProject {
  return {
    ...project,
    description: projectDescription(project),
    kind: project.clonedFromProjectId ? "clone" : "project",
    artifactRepoName: undefined,
    artifactRepoId: undefined,
    artifactRemote: project.artifactRemote
      ? artifactVanityRemote(project.artifactRemoteProjectId || project.id)
      : undefined,
  };
}

function nestProjectClones(projects: WorkspaceProject[]): WorkspaceProject[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const clonesBySource = new Map<string, WorkspaceProjectCloneSummary[]>();

  for (const project of projects) {
    if (!project.clonedFromProjectId) continue;
    const sourceId = project.artifactRemoteProjectId || project.clonedFromProjectId;
    const source = byId.get(sourceId) ?? byId.get(project.clonedFromProjectId);
    project.cloneSource = source
      ? { id: source.id, name: source.name, description: projectDescription(source) }
      : { id: sourceId, name: sourceId, description: `Source project ${sourceId}.` };
    const clones = clonesBySource.get(sourceId) ?? [];
    clones.push(toProjectCloneSummary(project));
    clonesBySource.set(sourceId, clones);
  }

  for (const project of projects) {
    const clones = clonesBySource.get(project.id) ?? [];
    clones.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    project.clones = clones;
    project.cloneCount = clones.length;
  }

  return projects.filter((project) => project.kind !== "clone");
}

function toProjectCloneSummary(project: WorkspaceProject): WorkspaceProjectCloneSummary {
  if (!project.clonedFromProjectId) {
    throw new Error(`Project ${project.id} is not a clone`);
  }
  return {
    id: project.id,
    name: project.name,
    description: projectDescription(project),
    defaultVmId: project.defaultVmId,
    backend: project.backend ?? "vm",
    clonedFromProjectId: project.clonedFromProjectId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function globalProjectId(workspaceId: string, value: unknown): string {
  const workspacePart = compactWorkspaceId(workspaceId);
  const slug = normalizeRegistryId(value, "project");
  const slugPart = slug.slice(0, 14) || "project";
  const hash = fnv1a(`${workspaceId}:${slug}`).toString(36).slice(0, 4).padStart(4, "0");
  return normalizeGlobalProjectId(`ca-${workspacePart}-${slugPart}-${hash}`);
}

function compactWorkspaceId(workspaceId: string): string {
  const compact = workspaceId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.length >= 32) return compact.slice(0, 32);
  return `${compact}${fnv1a(workspaceId).toString(36)}`.slice(0, 32).padEnd(32, "0");
}

function requireProjectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("project name is required");
  }
  return value.trim();
}

function requireProjectNameKey(value: unknown, label: string): string {
  const key = projectNameKey(requireProjectName(value));
  if (!key) throw new Error(`${label} is required`);
  return key;
}

function projectNameKey(value: unknown): string {
  return normalizeRegistryId(value, "project");
}

export { projectNameKey };

function requireWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("workspaceId is required to create a globally unique project id");
  }
  return value.trim();
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isWorkspaceProject(value: unknown): value is WorkspaceProject {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as WorkspaceProject).id === "string" &&
      typeof (value as WorkspaceProject).name === "string",
  );
}

function projectDescription(project: Pick<WorkspaceProject, "id" | "name"> & { description?: unknown }): string {
  return typeof project.description === "string" && project.description.trim()
    ? project.description.trim()
    : `Project ${project.name || project.id}.`;
}

function requireProjectDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("project description is required");
  }
  const description = value.trim();
  if (!description) {
    throw new Error("project description is required");
  }
  return description;
}

function requireProjectBackend(value: unknown): WorkspaceProjectBackend {
  if (value === "vm" || value === "do-r2") return value;
  throw new Error('project backend must be "vm" or "do-r2"');
}

function normalizeProjectSnapshotPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

function shouldIgnoreProjectSnapshotPath(path: string): boolean {
  return path.split("/").some((part) =>
    part === "node_modules" ||
    part === ".git" ||
    part === ".wrangler" ||
    part === ".cache" ||
    part === "dist" ||
    part === "build"
  );
}

function requireSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value.trim())) {
    throw new Error("snapshot id is required");
  }
  return value.trim();
}

function projectSnapshotBlobKey(durableId: string, sha256: string): string {
  return `project-source-snapshots/${durableId}/${sha256}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function relativeUnderRoot(root: string, path: string): string {
  const normalizedRoot = normalizeWorkspacePath(root).replace(/\/+$/, "") || "/";
  const normalizedPath = normalizeWorkspacePath(path);
  if (normalizedRoot === "/") return normalizedPath.replace(/^\/+/, "");
  if (normalizedPath === normalizedRoot) return "";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath.replace(/^\/+/, "");
}

function toListEntry(entry: FileInfo, root: string, absolutePath: string): WorkspaceListEntry {
  return {
    name: entry.name,
    type: entry.type === "directory" ? "directory" : "file",
    size: entry.size,
    modifiedAt: new Date(entry.updatedAt).toISOString(),
    relativePath: relativeUnderRoot(root, absolutePath || entry.path),
    absolutePath: normalizeWorkspacePath(absolutePath || entry.path),
    mimeType: entry.mimeType,
  };
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function decodeMaybeText(bytes: Uint8Array): { content: string; isBinary: boolean } {
  if (bytes.includes(0)) {
    return { content: bytesToBase64(bytes), isBinary: true };
  }
  try {
    return { content: new TextDecoder("utf-8", { fatal: true }).decode(bytes), isBinary: false };
  } catch {
    return { content: bytesToBase64(bytes), isBinary: true };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArtifactsBindingUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return normalized.includes("binding artifacts needs to be run remotely") ||
    normalized.includes("artifacts binding is not configured");
}
