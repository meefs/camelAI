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
  migratedFrom?: WorkspaceProjectMigrationSource;
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProjectMigrationSource {
  workspaceId: string;
  legacyRoot: string;
  sourcePaths: string[];
  migratedAt: string;
}

export type LegacyWorkspaceMigrationStatus =
  | "not_started"
  | "queued"
  | "scanning_legacy"
  | "planning"
  | "copying"
  | "verifying"
  | "dry_run_complete"
  | "complete"
  | "failed";

export interface LegacyWorkspaceMigrationProjectPlan {
  name: string;
  description: string;
  sourcePaths: string[];
  deployedApps?: string[];
  ignoreGlobs?: string[];
  reason?: string;
}

export interface LegacyWorkspaceMigrationWorkspaceFilePlan {
  sourcePath: string;
  destinationPath: string;
  reason?: string;
}

export interface LegacyWorkspaceMigrationPlan {
  projects: LegacyWorkspaceMigrationProjectPlan[];
  workspaceFiles?: LegacyWorkspaceMigrationWorkspaceFilePlan[];
  unclassified?: string[];
}

export interface LegacyWorkspaceMigrationDiagnostics {
  legacyRoot?: string;
  legacyFileCount?: number;
  deployedAppCount?: number;
  deployedAppNames?: string[];
  warnings?: string[];
}

export interface LegacyWorkspaceMigrationState {
  workspaceId: string;
  orgId?: string;
  migrationVersion: number;
  status: LegacyWorkspaceMigrationStatus;
  workflowId?: string;
  leaseId?: string;
  attempts: number;
  plan?: LegacyWorkspaceMigrationPlan;
  createdProjects?: string[];
  copiedFiles?: number;
  copiedBytes?: number;
  skippedPaths?: string[];
  diagnostics?: LegacyWorkspaceMigrationDiagnostics;
  error?: string;
  startedAt?: string;
  updatedAt: string;
  completedAt?: string;
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
  clonedFromProjectId: string;
  artifactRemote?: string;
  artifactStatus?: WorkspaceProject["artifactStatus"];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFilesystemLike {
  exists(path: string): Promise<WorkspaceExistsResponse>;
  readFile(path: string): Promise<WorkspaceReadFileResponse>;
  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse>;
  writeBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse>;
  listFiles(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean; limit?: number },
  ): Promise<WorkspaceListResponse>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<WorkspaceWriteResponse>;
  deleteFile(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<WorkspaceWriteResponse>;
  listProjects(): Promise<WorkspaceProject[]>;
  getProject(projectId: unknown): Promise<WorkspaceProject | null>;
  getProjectByName(project: unknown): Promise<WorkspaceProject | null>;
  createProject(input?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    migratedFrom?: WorkspaceProjectMigrationSource;
  }): Promise<WorkspaceProject>;
  setProjectDescription(input?: { project?: unknown; projectId?: unknown; description?: unknown }): Promise<WorkspaceProject>;
  cloneProject(input?: {
    sourceProject?: unknown;
    sourceProjectId?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject>;
  getLegacyWorkspaceMigrationState(): Promise<LegacyWorkspaceMigrationState>;
  setLegacyWorkspaceMigrationState(
    input: Partial<LegacyWorkspaceMigrationState> & { status: LegacyWorkspaceMigrationStatus },
  ): Promise<LegacyWorkspaceMigrationState>;
  mintProjectArtifactToken(
    projectId: unknown,
    scope?: "read" | "write",
    ttlSeconds?: number,
  ): Promise<ProjectArtifactToken>;
}

export interface ProjectArtifactToken {
  project: WorkspaceProject;
  token: string;
  expiresAt?: string | number;
  artifactRemote: string;
  artifactRemoteProjectId: string;
}

const PROJECTS_KEY = "projects:v1";
export const CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION = 2;
const LEGACY_MIGRATION_KEY = "legacy-workspace-migration:v1";
const DEFAULT_PROJECT_VM_ID = "main";
const ARTIFACTS_DEFAULT_BRANCH = "main";
export const ARTIFACTS_VANITY_HOST = "artifacts.camelai.internal";

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
  remote: string;
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

export class WorkspaceFilesystemDO extends DurableObject<WorkspaceFilesystemEnv> {
  private readonly workspace: Workspace;

  constructor(ctx: DurableObjectState, env: WorkspaceFilesystemEnv) {
    super(ctx, env);
    const durableId = ctx.id.toString();
    this.workspace = new Workspace({
      sql: ctx.storage.sql,
      r2: env.R2_BUCKET,
      r2Prefix: `workspace-fs/${durableId}`,
      inlineThreshold: DEFAULT_INLINE_THRESHOLD,
      name: durableId,
    });
  }

  async exists(path: string): Promise<WorkspaceExistsResponse> {
    const stat = await this.workspace.stat(normalizeWorkspacePath(path));
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
    const normalizedPath = normalizeWorkspacePath(path);
    const bytes = await this.workspace.readFileBytes(normalizedPath);
    if (!bytes) {
      return { success: false, error: "File not found", code: "ENOENT" };
    }
    const stat = await this.workspace.stat(normalizedPath);
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

  async writeFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    try {
      await this.workspace.writeFile(normalizeWorkspacePath(path), content);
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EWRITE" };
    }
  }

  async writeBinaryFile(path: string, base64Content: string): Promise<WorkspaceWriteResponse> {
    try {
      await this.workspace.writeFileBytes(
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
    const root = normalizeWorkspacePath(path);
    const includeHidden = options.includeHidden === true;
    const limit = Math.max(1, Math.min(50_000, Math.floor(options.limit ?? 10_000)));

    try {
      const stat = await this.workspace.stat(root);
      if (!stat) throw new Error(`Path not found: ${root}`);
      const files: WorkspaceListEntry[] = [];
      if (stat.type === "file") {
        files.push(toListEntry(stat, root, root));
      } else {
        await this.collectEntries(root, root, files, {
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
    try {
      await this.workspace.mkdir(normalizeWorkspacePath(path), { recursive: options.recursive === true });
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EMKDIR" };
    }
  }

  async deleteFile(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    try {
      await this.workspace.rm(normalizeWorkspacePath(path), {
        recursive: options.recursive === true,
        force: options.force === true,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EDELETE" };
    }
  }

  async listProjects(): Promise<WorkspaceProject[]> {
    return nestProjectClones((await this.readProjects()).map(toPublicProject));
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

  async createProject(input: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    workspaceId?: unknown;
    migratedFrom?: WorkspaceProjectMigrationSource;
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
    const project = await this.ensureProjectArtifactRepo({
      id,
      name,
      description,
      defaultVmId: DEFAULT_PROJECT_VM_ID,
      migratedFrom: normalizeProjectMigrationSource(input.migratedFrom),
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

  async getLegacyWorkspaceMigrationState(): Promise<LegacyWorkspaceMigrationState> {
    return await this.readLegacyWorkspaceMigrationState();
  }

  async setLegacyWorkspaceMigrationState(
    input: Partial<LegacyWorkspaceMigrationState> & { status: LegacyWorkspaceMigrationStatus },
  ): Promise<LegacyWorkspaceMigrationState> {
    const current = await this.readLegacyWorkspaceMigrationState();
    const now = new Date().toISOString();
    const next: LegacyWorkspaceMigrationState = {
      ...current,
      ...input,
      workspaceId: this.ctx.id.toString(),
      migrationVersion: CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION,
      attempts:
        typeof input.attempts === "number" && Number.isFinite(input.attempts)
          ? Math.max(0, Math.floor(input.attempts))
          : current.attempts,
      updatedAt: now,
    };
    if (!next.startedAt && next.status !== "not_started" && next.status !== "queued") {
      next.startedAt = now;
    }
    if (next.status === "queued" || next.status === "not_started") {
      delete next.plan;
      delete next.createdProjects;
      delete next.copiedFiles;
      delete next.copiedBytes;
      delete next.skippedPaths;
      delete next.diagnostics;
      delete next.leaseId;
      delete next.startedAt;
      delete next.completedAt;
    }
    if (next.status !== "failed") {
      delete next.error;
    }
    if (!["dry_run_complete", "complete", "failed"].includes(next.status)) {
      delete next.completedAt;
    }
    if ((next.status === "complete" || next.status === "failed") && !next.completedAt) {
      next.completedAt = now;
    }
    await this.ctx.storage.kv.put(LEGACY_MIGRATION_KEY, next);
    return next;
  }

  async mintProjectArtifactToken(
    projectId: unknown,
    scope: "read" | "write" = "write",
    ttlSeconds = 600,
  ): Promise<ProjectArtifactToken> {
    const id = requireProjectId(projectId, "project");
    const existing = (await this.readProjects()).find((candidate) => candidate.id === id);
    const project = existing ? await this.ensureProjectArtifactsReady(existing) : null;
    if (!project) {
      throw new Error(`Project not found: ${String(projectId)}`);
    }
    if (!project.artifactRepoName || !project.artifactRemote || project.artifactStatus === "error") {
      throw new Error(`Project ${project.id} is not backed by an Artifacts repo`);
    }
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) {
      throw new Error("ARTIFACTS binding is not configured");
    }
    const repo = await artifacts.get(project.artifactRepoName);
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

  private async readLegacyWorkspaceMigrationState(): Promise<LegacyWorkspaceMigrationState> {
    const value = await this.ctx.storage.kv.get<LegacyWorkspaceMigrationState>(LEGACY_MIGRATION_KEY);
    if (isLegacyWorkspaceMigrationState(value)) {
      return {
        ...value,
        migrationVersion: normalizeLegacyWorkspaceMigrationVersion(value.migrationVersion),
      };
    }
    return {
      workspaceId: this.ctx.id.toString(),
      migrationVersion: CURRENT_LEGACY_WORKSPACE_MIGRATION_VERSION,
      status: "not_started",
      attempts: 0,
      updatedAt: new Date(0).toISOString(),
    };
  }

  private async ensureProjectArtifactRepo(project: WorkspaceProject): Promise<WorkspaceProject> {
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) return project;

    const repoName = project.artifactRepoName || artifactRepoName(this.ctx.id.toString(), project.id);
    try {
      const repo = await createOrGetArtifactRepo(artifacts, repoName, project);
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
      const updated: WorkspaceProject = {
        ...project,
        artifactRepoName: repoName,
        artifactStatus: "error",
        updatedAt: new Date().toISOString(),
      };
      await this.replaceProject(updated);
      console.error("[WorkspaceFilesystemDO] failed to ensure Artifacts repo", {
        projectId: project.id,
        repoName,
        error: errorMessage(error),
      });
      return updated;
    }
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
    root: string,
    dir: string,
    files: WorkspaceListEntry[],
    options: { recursive: boolean; includeHidden: boolean; limit: number },
  ): Promise<void> {
    if (files.length >= options.limit) return;
    const entries = await this.workspace.readDir(dir, { limit: options.limit });
    for (const entry of entries) {
      if (files.length >= options.limit) return;
      const relativePath = relativeUnderRoot(root, entry.path);
      if (!options.includeHidden && isHiddenPath(relativePath)) continue;
      files.push(toListEntry(entry, root, entry.path));
      if (options.recursive && entry.type === "directory") {
        await this.collectEntries(root, entry.path, files, options);
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

  getProject(projectId: unknown): Promise<WorkspaceProject | null> {
    return this.stub.getProject(projectId);
  }

  getProjectByName(project: unknown): Promise<WorkspaceProject | null> {
    return this.stub.getProjectByName(project);
  }

  createProject(input?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
    migratedFrom?: WorkspaceProjectMigrationSource;
  }): Promise<WorkspaceProject> {
    return this.stub.createProject({ ...input, workspaceId: this.workspaceId });
  }

  setProjectDescription(input?: { project?: unknown; projectId?: unknown; description?: unknown }): Promise<WorkspaceProject> {
    return this.stub.setProjectDescription(input);
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

  getLegacyWorkspaceMigrationState(): Promise<LegacyWorkspaceMigrationState> {
    return this.stub.getLegacyWorkspaceMigrationState();
  }

  setLegacyWorkspaceMigrationState(
    input: Partial<LegacyWorkspaceMigrationState> & { status: LegacyWorkspaceMigrationStatus },
  ): Promise<LegacyWorkspaceMigrationState> {
    return this.stub.setLegacyWorkspaceMigrationState(input);
  }

  mintProjectArtifactToken(
    projectId: unknown,
    scope?: "read" | "write",
    ttlSeconds?: number,
  ): Promise<ProjectArtifactToken> {
    return this.stub.mintProjectArtifactToken(projectId, scope, ttlSeconds);
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
): Promise<ArtifactsRepoInfo> {
  try {
    return await artifacts.get(repoName);
  } catch {
    return artifacts.create(repoName, {
      description: `camelAI project ${project.id}`,
      readOnly: false,
      setDefaultBranch: ARTIFACTS_DEFAULT_BRANCH,
    });
  }
}

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
    clonedFromProjectId: project.clonedFromProjectId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

function globalProjectId(workspaceId: string, value: unknown): string {
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

function normalizeLegacyWorkspaceMigrationVersion(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : 0;
}

function isLegacyWorkspaceMigrationState(value: unknown): value is LegacyWorkspaceMigrationState {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof (value as LegacyWorkspaceMigrationState).workspaceId === "string" &&
      typeof (value as LegacyWorkspaceMigrationState).status === "string" &&
      typeof (value as LegacyWorkspaceMigrationState).attempts === "number" &&
      typeof (value as LegacyWorkspaceMigrationState).updatedAt === "string",
  );
}

function normalizeProjectMigrationSource(value: unknown): WorkspaceProjectMigrationSource | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<WorkspaceProjectMigrationSource>;
  if (typeof candidate.workspaceId !== "string" || !candidate.workspaceId.trim()) return undefined;
  const sourcePaths = Array.isArray(candidate.sourcePaths)
    ? candidate.sourcePaths
        .filter((path): path is string => typeof path === "string" && path.trim().length > 0)
        .map((path) => path.trim())
    : [];
  if (sourcePaths.length === 0) return undefined;
  return {
    workspaceId: candidate.workspaceId.trim(),
    legacyRoot:
      typeof candidate.legacyRoot === "string" && candidate.legacyRoot.trim()
        ? normalizeWorkspacePath(candidate.legacyRoot)
        : LEGACY_WORKSPACE_ROOT,
    sourcePaths,
    migratedAt:
      typeof candidate.migratedAt === "string" && candidate.migratedAt.trim()
        ? candidate.migratedAt.trim()
        : new Date().toISOString(),
  };
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
