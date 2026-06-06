import { type WorkflowEvent } from "cloudflare:workers";
import { Think } from "@cloudflare/think";
import { ThinkWorkflow, type ThinkWorkflowStep } from "@cloudflare/think/workflows";
import { getAgentByName } from "agents";
import { tool } from "ai";
import { createWorkersAI } from "workers-ai-provider";
import { z } from "zod";
import type { WorkerScript } from "./auth.js";
import { getOrgStub } from "./helpers/stubs.js";
import type { Env } from "./types.js";
import {
  WorkspaceFilesystemClient,
  type LegacyWorkspaceMigrationDiagnostics,
  type LegacyWorkspaceMigrationPlan,
  type LegacyWorkspaceMigrationProjectPlan,
} from "./workspace-filesystem-do.js";

const LEGACY_ROOT = "/home/claude";
const MIGRATION_LEASE_TTL_MS = 2 * 60 * 60 * 1000;
const MIGRATION_CONTEXT_STEP_TIMEOUT = "15 minutes";
const MIGRATION_AI_STEP_TIMEOUT = "45 minutes";
const MIGRATION_IMPORT_STEP_TIMEOUT = "2 hours";
const TOP_LEVEL_SCAN_LIMIT = 2_000;
const NAMING_CONTEXT_MAX_PROJECTS = 150;
const NAMING_CONTEXT_MAX_ENTRIES_PER_PROJECT = 80;
const NAMING_CONTEXT_MAX_SAMPLES_PER_PROJECT = 6;
const NAMING_CONTEXT_MAX_SAMPLE_BYTES = 8_000;
const NAMING_CONTEXT_MAX_READ_BYTES = 2_000_000;
const NAMING_CONTEXT_MAX_TOTAL_CHARS = 80_000;
const MIGRATION_PLANNING_WORKERS_AI_MODEL = "openai/gpt-5.5";
const MIGRATION_PLANNING_RESPONSES_MODEL = "gpt-5.5";
const MIGRATION_PLANNING_RESPONSE_SCHEMA_NAME = "legacy_workspace_migration_plan";
const DESCRIPTION_MAX_LENGTH = 240;
const TEXT_CONTEXT_FILE_EXTENSIONS = new Set([
  ".csv",
  ".ipynb",
  ".js",
  ".json",
  ".jsonc",
  ".jsx",
  ".md",
  ".mjs",
  ".py",
  ".r",
  ".rmd",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".yaml",
  ".yml",
]);
const TEXT_CONTEXT_FILE_NAMES = new Set([
  "cargo.toml",
  "deno.json",
  "go.mod",
  "package.json",
  "pyproject.toml",
  "readme",
  "readme.md",
  "requirements.txt",
  "vite.config.js",
  "vite.config.ts",
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
]);
const WRANGLER_CONFIG_FILE_NAMES = new Set([
  "wrangler.json",
  "wrangler.jsonc",
  "wrangler.toml",
]);
const SENSITIVE_CONTEXT_NAME_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)$/i,
  /(?:^|[-_.])(secret|token|credential|credentials|private[-_.]?key|api[-_.]?key)(?:[-_.]|$)/i,
];
const LEGACY_IMPORT_IGNORE_GLOBS: string[] = [];

const migrationPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  orgId: z.string().min(1),
  requestedBy: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
});

type LegacyWorkspaceMigrationPayload = z.infer<typeof migrationPayloadSchema>;

const migrationAgentPlanSchema = z.object({
  projects: z.array(z.object({
    name: z.string().min(1).max(120),
    description: z.string().min(1).max(1_000),
    sourcePaths: z.array(z.string().min(1)).min(1),
    deployedApps: z.array(z.string().min(1)).optional(),
    reason: z.string().max(500).optional(),
  })).min(1),
});

export type MigrationAgentPlan = z.infer<typeof migrationAgentPlanSchema>;

const migrationAgentPlanJsonSchema = z.toJSONSchema(migrationAgentPlanSchema);

interface MigrationPlanningAgentConfig {
  orgId: string;
  workspaceId: string;
}

type MigrationThinkEnv = Env & Cloudflare.Env;

export interface RuntimeFileEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
  relativePath?: string;
  absolutePath?: string;
}

export interface LegacyWorkspaceMigrationRuntimeReader {
  listLegacyWorkspace(
    orgId: string,
    workspaceId: string,
    path: string,
    options?: { recursive?: boolean; limit?: number },
  ): Promise<{ files: RuntimeFileEntry[]; count: number }>;
  readLegacyText?(
    orgId: string,
    workspaceId: string,
    path: string,
    maxBytes?: number,
  ): Promise<string | null>;
}

interface LegacyWorkspaceMigrationRuntimeResetter {
  deleteProject(projectId: string): Promise<void>;
}

interface LegacyWorkspaceMigrationWorkspaceResetter {
  listProjects(): Promise<Array<{ id: string; migratedFrom?: { workspaceId: string } }>>;
  deleteMigratedProjectsForWorkspace(
    workspaceId?: unknown,
  ): Promise<{ deleted: Array<{ id: string }>; retained: Array<{ id: string }> }>;
}

interface LegacyImportResult {
  success?: boolean;
  files?: number;
  bytes?: number;
  skippedPaths?: string[];
}

export interface MigrationDeployedAppContext {
  scriptName: string;
  configPath: string | null;
  projectId: string | null;
  updatedAt: number;
  isPublic: boolean;
}

export class MigrationPlanningAgent extends Think<MigrationThinkEnv> {
  workspaceBash = false;
  maxSteps = 12;

  getModel() {
    return createWorkersAI({ binding: this.env.AI })(MIGRATION_PLANNING_WORKERS_AI_MODEL);
  }

  getSystemPrompt(): string {
    return [
      "You plan migrations from a legacy /home/claude workspace into project VMs.",
      "You may inspect the legacy filesystem with read-only tools.",
      "Return only the structured project plan requested by the workflow.",
      "Never include secrets or credential values in names, descriptions, or reasons.",
      "Prefer stable lowercase slug names and concise descriptions that explain what each project contains.",
      "Discover projects from the allowed legacy source paths instead of assuming every top-level folder is one project.",
      "Every allowed source path must be assigned exactly once. Do not invent, omit, or duplicate source paths.",
    ].join("\n");
  }

  getTools() {
    const getConfig = () => {
      const config = this.getConfig<MigrationPlanningAgentConfig>();
      if (!config?.orgId || !config.workspaceId) {
        throw new Error("MigrationPlanningAgent is not configured for a workspace");
      }
      return config;
    };

    return {
      list_legacy_path: tool({
        description: "List files or directories from the legacy /home/claude workspace for migration planning.",
        inputSchema: z.object({
          path: z.string().min(1),
          recursive: z.boolean().optional(),
          limit: z.number().int().min(1).max(500).optional(),
        }),
        execute: async ({ path, recursive, limit }) => {
          const config = getConfig();
          const runtime = new ProjectRuntimeMigrationClient(this.env);
          return runtime.listLegacyWorkspace(config.orgId, config.workspaceId, path, {
            recursive,
            limit: limit ?? NAMING_CONTEXT_MAX_ENTRIES_PER_PROJECT,
          });
        },
      }),
      read_legacy_text: tool({
        description: "Read a sanitized text sample from the legacy workspace. Secret-looking lines are redacted.",
        inputSchema: z.object({
          path: z.string().min(1),
          maxBytes: z.number().int().min(1).max(NAMING_CONTEXT_MAX_SAMPLE_BYTES).optional(),
        }),
        execute: async ({ path, maxBytes }) => {
          if (isSensitiveNamingPath(path)) return null;
          const config = getConfig();
          const runtime = new ProjectRuntimeMigrationClient(this.env);
          const text = await runtime.readLegacyText(
            config.orgId,
            config.workspaceId,
            path,
            maxBytes ?? NAMING_CONTEXT_MAX_SAMPLE_BYTES,
          );
          return sanitizeNamingSample(text);
        },
      }),
      list_deployed_apps: tool({
        description: "List deployed apps/workers that are currently associated with this legacy workspace.",
        inputSchema: z.object({}),
        execute: async () => {
          const config = getConfig();
          const org = getOrgStub(this.env, config.orgId);
          return (await org.listWorkerScriptsByWorkspace(config.workspaceId)).map(toMigrationDeployedAppContext);
        },
      }),
    };
  }

  async startMigration(input: LegacyWorkspaceMigrationPayload & { workflowId: string }): Promise<{ workflowId: string }> {
    const payload = migrationPayloadSchema.parse(input);
    this.configure<MigrationPlanningAgentConfig>({
      orgId: payload.orgId,
      workspaceId: payload.workspaceId,
    });
    await this.runWorkflow("LEGACY_WORKSPACE_MIGRATIONS", payload, {
      id: input.workflowId,
      agentBinding: "MIGRATION_PLANNING_AGENT",
      metadata: {
        orgId: payload.orgId,
        workspaceId: payload.workspaceId,
        requestedBy: payload.requestedBy,
      },
    });
    return { workflowId: input.workflowId };
  }
}

export async function startLegacyWorkspaceMigrationWorkflow(
  env: Pick<Env, "MIGRATION_PLANNING_AGENT">,
  input: LegacyWorkspaceMigrationPayload & { workflowId: string },
): Promise<void> {
  if (!env.MIGRATION_PLANNING_AGENT) {
    throw new Error("MIGRATION_PLANNING_AGENT binding is required");
  }
  const agent = await getAgentByName<MigrationThinkEnv, MigrationPlanningAgent>(
    env.MIGRATION_PLANNING_AGENT,
    `legacy-workspace-migration-${input.workspaceId}`,
  );
  await agent.startMigration(input);
}

export class LegacyWorkspaceMigrationWorkflow extends ThinkWorkflow<
  MigrationPlanningAgent,
  LegacyWorkspaceMigrationPayload,
  Record<string, unknown>,
  MigrationThinkEnv
> {
  override async run(
    event: WorkflowEvent<LegacyWorkspaceMigrationPayload>,
    step: ThinkWorkflowStep,
  ): Promise<unknown> {
    const payload = migrationPayloadSchema.parse(event.payload);
    const workspaceFs = new WorkspaceFilesystemClient(this.env, payload.workspaceId);
    const runtime = new ProjectRuntimeMigrationClient(this.env);
    const workflowId = event.instanceId;
    let leaseId: string | undefined;

    try {
      await step.do("mark-scanning", async () => {
        const current = await workspaceFs.getLegacyWorkspaceMigrationState();
        await workspaceFs.setLegacyWorkspaceMigrationState({
          status: "scanning_legacy",
          orgId: payload.orgId,
          workflowId,
          attempts: current.attempts + 1,
          startedAt: new Date().toISOString(),
          error: undefined,
        });
      });

      if (!payload.dryRun) {
        leaseId = await step.do("lock-legacy-workspace", async () => {
          const lock = await runtime.lockLegacyWorkspace(payload.orgId, payload.workspaceId, {
            workflowId,
            ttlMs: MIGRATION_LEASE_TTL_MS,
          });
          await workspaceFs.setLegacyWorkspaceMigrationState({
            status: "scanning_legacy",
            leaseId: lock.leaseId,
          });
          return lock.leaseId;
        });
      }

      const tree = await step.do("scan-legacy-workspace", async () => {
        return runtime.listLegacyWorkspace(payload.orgId, payload.workspaceId, LEGACY_ROOT, {
          recursive: false,
          limit: TOP_LEVEL_SCAN_LIMIT,
        });
      });

      const deployedApps = await step.do("list-deployed-apps", async () => {
        const org = getOrgStub(this.env, payload.orgId);
        return (await org.listWorkerScriptsByWorkspace(payload.workspaceId)).map(toMigrationDeployedAppContext);
      });

      const diagnostics = buildLegacyWorkspaceMigrationDiagnostics({
        legacyRoot: LEGACY_ROOT,
        legacyFileCount: tree.count,
        deployedApps,
      });

      await step.do("mark-planning", async () => {
        await workspaceFs.setLegacyWorkspaceMigrationState({ status: "planning", diagnostics, error: undefined });
      });

      if (tree.files.length === 0 && deployedApps.length > 0 && !payload.dryRun) {
        throw new Error(diagnostics.warnings?.[0] ?? "Legacy workspace scan returned no files");
      }

      const allowedSourcePlan = await step.do("build-agent-discovery-input", async () => {
        return buildLegacyWorkspaceMigrationSeedPlan({ entries: tree.files });
      });

      const enrichedPlan = allowedSourcePlan.projects.length === 0
        ? appendUnclassifiedMiscProject(allowedSourcePlan)
        : await (async () => {
            const discoveryContext = await step.do("build-discovery-context", {
              timeout: MIGRATION_CONTEXT_STEP_TIMEOUT,
              retries: { limit: 3, delay: "10 seconds", backoff: "exponential" },
            }, async () => {
              return await buildLegacyWorkspaceNamingContext({
                runtime,
                orgId: payload.orgId,
                workspaceId: payload.workspaceId,
                plan: allowedSourcePlan,
              });
            });

            const agentProposal = await step.do("discover-projects-with-ai", {
              timeout: MIGRATION_AI_STEP_TIMEOUT,
              retries: { limit: 2, delay: "30 seconds", backoff: "exponential" },
            }, async () => {
              return await runMigrationPlanningAi(this.env, buildMigrationPlanningPrompt({
                workspaceId: payload.workspaceId,
                plan: allowedSourcePlan,
                context: discoveryContext,
                deployedApps,
              }), allowedSourcePlan.projects.flatMap((project) => project.sourcePaths));
            });

            return await step.do("validate-agent-discovery-plan", async () => {
              return appendUnclassifiedMiscProject(
                applyMigrationAgentPlan(allowedSourcePlan, agentProposal, {
                  deployedApps,
                  workerAppSourcePaths: detectWorkerAppSourcePaths(discoveryContext),
                }),
              );
            });
          })();

      if (payload.dryRun) {
        await step.do("persist-dry-run-plan", async () => {
          await workspaceFs.setLegacyWorkspaceMigrationState({
            status: "dry_run_complete",
            plan: enrichedPlan,
            createdProjects: [],
            copiedBytes: 0,
            copiedFiles: 0,
            skippedPaths: [],
            diagnostics,
            completedAt: new Date().toISOString(),
            error: undefined,
          });
        });

        return { success: true, dryRun: true, plan: enrichedPlan };
      }

      await step.do("reset-previous-migrated-projects", {
        timeout: MIGRATION_IMPORT_STEP_TIMEOUT,
        retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
      }, async () => {
        await resetMigratedProjectsForWorkspace({
          workspaceFs,
          runtime,
          workspaceId: payload.workspaceId,
        });
      });

      await step.do("persist-plan", async () => {
        await workspaceFs.setLegacyWorkspaceMigrationState({
          status: "copying",
          plan: enrichedPlan,
          createdProjects: [],
          copiedBytes: 0,
          copiedFiles: 0,
          skippedPaths: [],
          diagnostics,
          error: undefined,
        });
      });

      const importResults = {
        createdProjects: [] as string[],
        copiedFiles: 0,
        copiedBytes: 0,
        skippedPaths: [] as string[],
      };

      for (const [index, projectPlan] of enrichedPlan.projects.entries()) {
        leaseId = await step.do(`refresh-legacy-workspace-lock-${index + 1}-${projectPlan.name}`, async () => {
          const lock = await runtime.lockLegacyWorkspace(payload.orgId, payload.workspaceId, {
            workflowId,
            ttlMs: MIGRATION_LEASE_TTL_MS,
          });
          await workspaceFs.setLegacyWorkspaceMigrationState({
            status: "copying",
            leaseId: lock.leaseId,
          });
          return lock.leaseId;
        });
        const result = await step.do(`import-project-${index + 1}-${projectPlan.name}`, {
          timeout: MIGRATION_IMPORT_STEP_TIMEOUT,
          retries: { limit: 3, delay: "30 seconds", backoff: "exponential" },
        }, async () => {
          return await importMigrationProject({
            workspaceFs,
            runtime,
            env: this.env,
            orgId: payload.orgId,
            workspaceId: payload.workspaceId,
            projectPlan,
          });
        });
        if (!importResults.createdProjects.includes(result.projectName)) {
          importResults.createdProjects.push(result.projectName);
        }
        importResults.copiedFiles += result.files ?? 0;
        importResults.copiedBytes += result.bytes ?? 0;
        importResults.skippedPaths.push(...(result.skippedPaths ?? []));
        await step.do(`record-import-progress-${index + 1}-${projectPlan.name}`, async () => {
          await workspaceFs.setLegacyWorkspaceMigrationState({
            status: "copying",
            createdProjects: importResults.createdProjects,
            copiedFiles: importResults.copiedFiles,
            copiedBytes: importResults.copiedBytes,
            skippedPaths: importResults.skippedPaths,
            error: undefined,
          });
        });
      }

      await step.do("mark-verifying", async () => {
        await workspaceFs.setLegacyWorkspaceMigrationState({
          status: "verifying",
          createdProjects: importResults.createdProjects,
          copiedFiles: importResults.copiedFiles,
          copiedBytes: importResults.copiedBytes,
          skippedPaths: importResults.skippedPaths,
          error: undefined,
        });
      });

      await step.do("verify-imports", async () => {
        if (enrichedPlan.projects.length > 0 && importResults.createdProjects.length !== enrichedPlan.projects.length) {
          throw new Error("Not all planned projects were created");
        }
        await workspaceFs.setLegacyWorkspaceMigrationState({
          status: "complete",
          completedAt: new Date().toISOString(),
          error: undefined,
        });
      });

      return { success: true, projects: importResults.createdProjects };
    } catch (error) {
      await workspaceFs.setLegacyWorkspaceMigrationState({
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      });
      throw error;
    } finally {
      if (leaseId) {
        const unlockLeaseId = leaseId;
        await step.do("unlock-legacy-workspace", async () => {
          await runtime.unlockLegacyWorkspace(payload.orgId, payload.workspaceId, unlockLeaseId);
        });
      }
    }
  }
}

async function importMigrationProject(input: {
  workspaceFs: WorkspaceFilesystemClient;
  runtime: ProjectRuntimeMigrationClient;
  env: Env;
  orgId: string;
  workspaceId: string;
  projectPlan: LegacyWorkspaceMigrationProjectPlan;
}): Promise<LegacyImportResult & { projectName: string }> {
  const { workspaceFs, runtime, env, orgId, workspaceId, projectPlan } = input;
  const org = getOrgStub(env, orgId);
  const existingProject = await workspaceFs.getProjectByName(projectPlan.name);
  const project = existingProject ?? await workspaceFs.createProject({
    name: projectPlan.name,
    description: projectPlan.description,
    migratedFrom: {
      workspaceId,
      legacyRoot: LEGACY_ROOT,
      sourcePaths: projectPlan.sourcePaths,
      migratedAt: new Date().toISOString(),
    },
  });
  if (existingProject && project.migratedFrom?.workspaceId !== workspaceId) {
    throw new Error(`Project already exists and was not created by this migration: ${projectPlan.name}`);
  }

  const result = await runtime.importLegacyWorkspace(orgId, workspaceId, project.id, {
    sourcePaths: projectPlan.sourcePaths,
    ignoreGlobs: projectPlan.ignoreGlobs ?? [],
  });

  for (const scriptName of projectPlan.deployedApps ?? []) {
    await org.updateWorkerScriptProject(scriptName, workspaceId, project.id, "system:legacy-migration");
  }

  return { ...result, projectName: project.name };
}

class ProjectRuntimeMigrationClient {
  constructor(private readonly env: Env) {}

  async listLegacyWorkspace(
    orgId: string,
    workspaceId: string,
    path: string,
    options: { recursive?: boolean; limit?: number } = {},
  ): Promise<{ files: RuntimeFileEntry[]; count: number }> {
    const url = this.runtimeUrl(
      `/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}/fs/list`,
      {
        path,
        recursive: options.recursive ? "true" : "false",
        includeHidden: "true",
      },
    );
    const result = await this.fetchLegacyJson<{ files?: RuntimeFileEntry[]; count?: number }>(url);
    const files = Array.isArray(result.files) ? result.files.slice(0, options.limit ?? TOP_LEVEL_SCAN_LIMIT) : [];
    return { files, count: typeof result.count === "number" ? result.count : files.length };
  }

  async readLegacyText(orgId: string, workspaceId: string, path: string, maxBytes = 128_000): Promise<string | null> {
    const response = await this.fetchLegacyRuntime(
      this.runtimeUrl(`/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}/fs/read`, { path }),
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error((await response.text()) || `Read failed: ${response.status}`);
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (Number.isFinite(contentLength) && contentLength > Math.max(maxBytes, NAMING_CONTEXT_MAX_READ_BYTES)) {
      return null;
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return new TextDecoder().decode(bytes.slice(0, maxBytes));
  }

  async lockLegacyWorkspace(
    orgId: string,
    workspaceId: string,
    input: { workflowId: string; ttlMs: number },
  ): Promise<{ leaseId: string }> {
    return this.fetchJson(
      this.runtimeUrl(`/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}/migration-lock`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    );
  }

  async unlockLegacyWorkspace(orgId: string, workspaceId: string, leaseId: string): Promise<void> {
    await this.fetchJson(
      this.runtimeUrl(`/v1/workspaces/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}/migration-lock`),
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leaseId }),
      },
    );
  }

  async importLegacyWorkspace(
    orgId: string,
    workspaceId: string,
    projectId: string,
    input: { sourcePaths: string[]; ignoreGlobs: string[] },
  ): Promise<LegacyImportResult> {
    return this.fetchJson(
      this.runtimeUrl(`/v1/projects/${encodeURIComponent(projectId)}/legacy-import`),
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          workspaceId,
          sourcePaths: input.sourcePaths,
          ignoreGlobs: input.ignoreGlobs,
        }),
      },
    );
  }

  async deleteProject(projectId: string): Promise<void> {
    const response = await this.fetchRuntime(
      this.runtimeUrl(`/v1/projects/${encodeURIComponent(projectId)}`),
      { method: "DELETE" },
    );
    if (response.status === 404) return;
    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `Runtime project delete failed: ${response.status}`);
    }
  }

  private async fetchJson<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchRuntime(input, init);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Runtime request failed: ${response.status}`);
    return text ? JSON.parse(text) as T : {} as T;
  }

  private async fetchLegacyJson<T>(input: string, init?: RequestInit): Promise<T> {
    const response = await this.fetchLegacyRuntime(input, init);
    const text = await response.text();
    if (!response.ok) throw new Error(text || `Legacy runtime request failed: ${response.status}`);
    return text ? JSON.parse(text) as T : {} as T;
  }

  private fetchLegacyRuntime(input: string, init?: RequestInit): Promise<Response> {
    if (this.env.LEGACY_WORKSPACE_HOST) {
      return this.env.LEGACY_WORKSPACE_HOST.fetch(new Request(input, this.withAuth(init)));
    }
    const base = this.env.LEGACY_WORKSPACE_SERVICE_URL?.replace(/\/+$/, "");
    if (base) {
      const url = new URL(input);
      return fetch(`${base}${url.pathname}${url.search}`, this.withAuth(init));
    }
    throw new Error("LEGACY_WORKSPACE_HOST or LEGACY_WORKSPACE_SERVICE_URL is required for legacy workspace migration");
  }

  private fetchRuntime(input: string, init?: RequestInit): Promise<Response> {
    if (this.env.PROJECT_RUNTIME_HOST) {
      return this.env.PROJECT_RUNTIME_HOST.fetch(new Request(input, this.withAuth(init)));
    }
    const base = this.env.PROJECT_RUNTIME_SERVICE_URL?.replace(/\/+$/, "");
    if (!base) throw new Error("PROJECT_RUNTIME_HOST or PROJECT_RUNTIME_SERVICE_URL is required");
    return fetch(`${base}${new URL(input).pathname}${new URL(input).search}`, this.withAuth(init));
  }

  private runtimeUrl(path: string, query?: Record<string, string>): string {
    const url = new URL(`http://project-runtime.local${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  private withAuth(init: RequestInit = {}): RequestInit {
    const headers = new Headers(init.headers);
    if (this.env.PROJECT_RUNTIME_SERVICE_BEARER_TOKEN && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.env.PROJECT_RUNTIME_SERVICE_BEARER_TOKEN}`);
    }
    return { ...init, headers };
  }
}

export function buildLegacyWorkspaceMigrationSeedPlan(input: {
  entries: RuntimeFileEntry[];
}): LegacyWorkspaceMigrationPlan {
  const projects: LegacyWorkspaceMigrationProjectPlan[] = [];
  const looseSourcePaths: string[] = [];
  const unclassified: string[] = [];

  for (const entry of input.entries) {
    const absolutePath = entry.absolutePath || joinLegacyPath(LEGACY_ROOT, entry.relativePath || entry.name);
    if (isPlanningOnlyPath(entry.name)) {
      unclassified.push(absolutePath);
      continue;
    }
    if (entry.type === "file") {
      looseSourcePaths.push(absolutePath);
      continue;
    }
    projects.push({
      name: uniqueProjectName(normalizeProjectName(entry.name), projects),
      description: `Legacy workspace path ${entry.name}.`,
      sourcePaths: [absolutePath],
      ignoreGlobs: LEGACY_IMPORT_IGNORE_GLOBS,
      reason: "Allowed source path for agent-led migration discovery.",
    });
  }

  if (looseSourcePaths.length > 0) {
    projects.push({
      name: uniqueProjectName("legacy-workspace-loose-files", projects),
      description: "Loose top-level legacy workspace files for semantic grouping during migration.",
      sourcePaths: looseSourcePaths,
      ignoreGlobs: LEGACY_IMPORT_IGNORE_GLOBS,
      reason: "Grouped loose top-level files so the migration planning agent clusters related files instead of treating each file as its own project.",
    });
  }

  return { projects, workspaceFiles: [], unclassified };
}

export interface LegacyWorkspaceNamingContext {
  workspaceId: string;
  projects: LegacyWorkspaceNamingProjectContext[];
}

export interface LegacyWorkspaceNamingProjectContext {
  index: number;
  currentName: string;
  currentDescription: string;
  reason?: string;
  sourcePaths: string[];
  entries: string[];
  samples: { path: string; text: string }[];
}

export async function buildLegacyWorkspaceNamingContext(input: {
  runtime: LegacyWorkspaceMigrationRuntimeReader;
  orgId: string;
  workspaceId: string;
  plan: LegacyWorkspaceMigrationPlan;
}): Promise<LegacyWorkspaceNamingContext> {
  const projects: LegacyWorkspaceNamingProjectContext[] = [];
  let budget = NAMING_CONTEXT_MAX_TOTAL_CHARS;

  for (const [index, project] of input.plan.projects.entries()) {
    if (projects.length >= NAMING_CONTEXT_MAX_PROJECTS || budget <= 0) break;
    const entries: string[] = [];
    const samples: { path: string; text: string }[] = [];

    for (const sourcePath of project.sourcePaths) {
      if (budget <= 0) break;
      if (looksLikeTextContextFile(sourcePath)) {
        const sample = await readNamingSample(input.runtime, input.orgId, input.workspaceId, sourcePath, budget);
        if (sample) {
          samples.push({ path: sourcePath, text: sample.text });
          budget -= sample.text.length;
        }
        continue;
      }

      const listing = await safeListNamingEntries(input.runtime, input.orgId, input.workspaceId, sourcePath);
      for (const entry of listing.files) {
        if (entries.length >= NAMING_CONTEXT_MAX_ENTRIES_PER_PROJECT) break;
        if (isPlanningOnlyPath(entry.name)) continue;
        const childPath = entry.absolutePath || joinLegacyPath(sourcePath, entry.relativePath || entry.name);
        entries.push(`${entry.type === "directory" ? "dir" : "file"} ${childPath}`);
        if (
          samples.length < NAMING_CONTEXT_MAX_SAMPLES_PER_PROJECT &&
          entry.type === "file" &&
          looksLikeTextContextFile(entry.name)
        ) {
          const sample = await readNamingSample(input.runtime, input.orgId, input.workspaceId, childPath, budget);
          if (sample) {
            samples.push({ path: childPath, text: sample.text });
            budget -= sample.text.length;
          }
        }
      }
    }

    projects.push({
      index,
      currentName: project.name,
      currentDescription: project.description,
      reason: project.reason,
      sourcePaths: project.sourcePaths,
      entries,
      samples,
    });
  }

  return { workspaceId: input.workspaceId, projects };
}

async function safeListNamingEntries(
  runtime: LegacyWorkspaceMigrationRuntimeReader,
  orgId: string,
  workspaceId: string,
  path: string,
): Promise<{ files: RuntimeFileEntry[]; count: number }> {
  try {
    return await runtime.listLegacyWorkspace(orgId, workspaceId, path, {
      recursive: false,
      limit: NAMING_CONTEXT_MAX_ENTRIES_PER_PROJECT,
    });
  } catch {
    return { files: [], count: 0 };
  }
}

async function readNamingSample(
  runtime: LegacyWorkspaceMigrationRuntimeReader,
  orgId: string,
  workspaceId: string,
  path: string,
  remainingBudget: number,
): Promise<{ text: string } | null> {
  if (!runtime.readLegacyText || remainingBudget <= 0) return null;
  if (isSensitiveNamingPath(path)) return null;
  try {
    const text = await runtime.readLegacyText(
      orgId,
      workspaceId,
      path,
      Math.min(NAMING_CONTEXT_MAX_SAMPLE_BYTES, remainingBudget),
    );
    const cleaned = sanitizeNamingSample(text);
    return cleaned ? { text: cleaned } : null;
  } catch {
    return null;
  }
}

export function buildMigrationPlanningPrompt(input: {
  workspaceId: string;
  plan: LegacyWorkspaceMigrationPlan;
  context: LegacyWorkspaceNamingContext;
  deployedApps?: MigrationDeployedAppContext[];
}): string {
  const detectedWorkerAppPaths = detectWorkerAppSourcePaths(input.context);
  return JSON.stringify({
    task:
      "Discover projects in this legacy workspace from the provided scan context. Return a final project plan that groups the allowed top-level source paths into coherent projects, including one misc project for leftovers when needed. Also associate deployed apps/workers with the project that contains their source only when the relationship is directly evidenced.",
    hard_requirements: [
      "Use every source path from allowed_source_paths exactly once.",
      "Do not invent source paths.",
      "Do not omit or duplicate source paths.",
      "Treat source_path_seed_plan as discovery input, not as the final grouping. You may split or merge non-Worker loose file paths when the final plan is more coherent.",
      "Only use deployed app names from deployed_apps.",
      "Do not assign one deployed app to more than one project.",
      "Associate a deployed app only when its configPath is inside one of the project's sourcePaths, its projectId clearly identifies that project, or its scriptName matches a project source directory name.",
      "Leave deployedApps empty when the source project is unclear, when configPath is null and there is no scriptName/sourcePath match, or when multiple projects could plausibly own the app.",
      "Use lowercase slug names with letters, numbers, and hyphens.",
      "Descriptions should be concise and specific to the project contents.",
      "A project can contain multiple source paths when they clearly belong together.",
      "Loose top-level files should usually be clustered by topic, notebook/script/data relationship, or put in the single misc project. Do not create one-file projects for images, CSVs, JSON outputs, logs, lockfiles, or generated artifacts unless the file is clearly a standalone user-authored project.",
      "Prefer grouping a notebook or script with its related data files, output images, JSON exports, markdown notes, or HTML reports when filenames or samples show the same topic.",
      "Do not group unrelated deployable apps into one project just because they are all apps; separate app directories should usually be separate projects unless the context shows they share one repo or product.",
      "Treat a source path with a wrangler.toml, wrangler.json, or wrangler.jsonc file as a Worker app project boundary.",
      "Do not include multiple independent Worker apps in the same project. If multiple source paths each contain a Wrangler config, return them as separate projects.",
      "Do not put two detected_worker_app_paths entries in the same project. Worker app source paths are hard project boundaries, even if they are nearby or have similar names.",
      "Use at most one misc project for unrelated loose files, caches, dotfolders, or leftovers that still need to be moved.",
      "Do not name a real project misc, legacy-workspace-misc, leftovers, or unclassified unless it is the single leftover bucket.",
      "Do not expose secrets or credential values.",
    ],
    deployed_app_evidence_rules: {
      strong_evidence: [
        "deployed app configPath is within a source path assigned to the project",
        "deployed app projectId clearly refers to the project",
        "deployed app scriptName equals the basename of a source directory assigned to the project",
      ],
      weak_evidence: [
        "similar technology stack",
        "similar generic names like app, worker, demo, test, or template",
        "missing configPath with no source directory name match",
      ],
      instruction: "Only include deployedApps with strong evidence. Weak evidence means leave the app unassociated.",
    },
    project_detection_script: [
      "function detectWorkerAppProjects(projects) {",
      "  const wranglerFiles = new Set(['wrangler.toml', 'wrangler.json', 'wrangler.jsonc']);",
      "  return projects.flatMap((project) => {",
      "    const hasWranglerConfig = project.entries.some((entry) => {",
      "      const parts = entry.trim().split(/\\s+/);",
      "      const path = parts[parts.length - 1] || '';",
      "      return wranglerFiles.has(path.split('/').pop());",
      "    });",
      "    return hasWranglerConfig ? project.sourcePaths : [];",
      "  });",
      "}",
    ].join("\n"),
    detected_worker_app_paths: detectedWorkerAppPaths,
    detected_worker_app_instruction:
      "Each detected_worker_app_paths entry is a Worker app boundary. Keep every detected Worker app source path in its own project and never group two detected Worker apps together.",
    workspace_id: input.workspaceId,
    allowed_source_paths: input.plan.projects.flatMap((project) => project.sourcePaths),
    deployed_apps: input.deployedApps ?? [],
    source_path_seed_plan: input.plan,
    initial_context: input.context,
  });
}

export function detectWorkerAppSourcePaths(context: LegacyWorkspaceNamingContext): string[] {
  const workerAppPaths = new Set<string>();
  for (const project of context.projects) {
    if (!project.entries.some(entryReferencesWranglerConfig)) continue;
    for (const sourcePath of project.sourcePaths) {
      workerAppPaths.add(sourcePath);
    }
  }
  return Array.from(workerAppPaths);
}

function entryReferencesWranglerConfig(entry: string): boolean {
  const path = entry.trim().split(/\s+/).pop() ?? "";
  const name = path.split("/").pop()?.toLowerCase() ?? "";
  return WRANGLER_CONFIG_FILE_NAMES.has(name);
}

export async function runMigrationPlanningAi(
  env: Pick<MigrationThinkEnv, "AI_GATEWAY_AUTH_TOKEN" | "CF_ACCOUNT_ID" | "CF_GATEWAY_NAME" | "CF_GATEWAY_TOKEN">,
  prompt: string,
  allowedSourcePaths?: string[],
): Promise<MigrationAgentPlan> {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const gatewayName = env.CF_GATEWAY_NAME?.trim();
  const token = env.AI_GATEWAY_AUTH_TOKEN?.trim() || env.CF_GATEWAY_TOKEN?.trim();
  if (!accountId || !gatewayName || !token) {
    throw new Error("Cloudflare AI Gateway Responses API is not configured for legacy workspace migration planning");
  }
  const response = await fetch(
    `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayName)}/openai/responses`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(buildMigrationPlanningResponsesRequest(prompt, allowedSourcePaths)),
    },
  );
  if (!response.ok) {
    const responseText = await response.text();
    const payload = responseText ? safeJsonParse(responseText) : undefined;
    throw new Error(
      extractCloudflareAiErrorMessage(payload)
      ?? responseText.trim()
      ?? `Cloudflare AI Gateway Responses API request failed (${response.status})`,
    );
  }
  const payload = await readMigrationPlanningResponsesPayload(response);
  return parseMigrationPlanningAiResult(payload);
}

export function buildMigrationPlanningResponsesRequest(prompt: string, allowedSourcePaths?: string[]): Record<string, unknown> {
  return {
    model: MIGRATION_PLANNING_RESPONSES_MODEL,
    stream: true,
    instructions: [
      "You plan migrations from a legacy /home/claude workspace into project VMs.",
      "Return only structured output matching the requested migration project plan schema.",
      "Never include secrets or credential values in names, descriptions, or reasons.",
      "Prefer stable lowercase slug names and concise descriptions that explain what each project contains.",
      "Every allowed source path must be assigned exactly once. Do not invent, omit, or duplicate source paths.",
      "The seed plan is discovery context, not the final project list. Cluster related loose files and avoid one-file projects for generated outputs.",
      "Only associate deployed apps when there is concrete source evidence; never guess from generic app names.",
      "A source path containing wrangler.toml, wrangler.json, or wrangler.jsonc is a Worker app project boundary. Never group two detected Worker app source paths into one project.",
      "Use at most one misc/leftover project.",
    ].join("\n"),
    input: prompt,
    text: {
      format: buildMigrationPlanningTextFormat(allowedSourcePaths),
    },
  };
}

export function buildMigrationPlanningTextFormat(allowedSourcePaths?: string[]): {
  type: "json_schema";
  name: string;
  strict: true;
  schema: unknown;
} {
  return {
    type: "json_schema",
    name: MIGRATION_PLANNING_RESPONSE_SCHEMA_NAME,
    strict: true,
    schema: buildMigrationAgentPlanJsonSchema(allowedSourcePaths),
  };
}

function buildMigrationAgentPlanJsonSchema(allowedSourcePaths?: string[]): unknown {
  const schema = structuredClone(migrationAgentPlanJsonSchema) as Record<string, unknown>;
  const properties = schema.properties as Record<string, unknown> | undefined;
  const projects = properties?.projects as Record<string, unknown> | undefined;
  const projectItems = projects?.items as Record<string, unknown> | undefined;
  projectItems && ensureStrictObjectSchemaRequiresAllProperties(projectItems);
  const projectProperties = projectItems?.properties as Record<string, unknown> | undefined;
  const sourcePaths = projectProperties?.sourcePaths as Record<string, unknown> | undefined;
  const sourcePathItems = sourcePaths?.items as Record<string, unknown> | undefined;
  if (allowedSourcePaths?.length && sourcePathItems) {
    sourcePathItems.enum = allowedSourcePaths;
  }
  return schema;
}

function ensureStrictObjectSchemaRequiresAllProperties(schema: Record<string, unknown>): void {
  const properties = schema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) return;
  schema.required = Object.keys(properties as Record<string, unknown>);
}

export async function readMigrationPlanningResponsesPayload(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/event-stream") || !response.body) {
    const responseText = await response.text();
    return responseText ? safeJsonParse(responseText) : undefined;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let outputText = "";
  let completedPayload: unknown;

  const consumeEvent = (rawEvent: string) => {
    const lines = rawEvent.split(/\r?\n/);
    let eventName = "";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    if (dataLines.length === 0) return;
    const dataText = dataLines.join("\n");
    if (dataText === "[DONE]") return;
    const eventPayload = safeJsonParse(dataText);
    if (!eventPayload || typeof eventPayload !== "object") return;
    const record = eventPayload as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : eventName;

    if (type === "response.output_text.delta" && typeof record.delta === "string") {
      outputText += record.delta;
      return;
    }
    if (type === "response.output_text.done" && typeof record.text === "string") {
      outputText = record.text;
      return;
    }
    if (type === "response.completed") {
      completedPayload = record.response ?? eventPayload;
      return;
    }
    if (type === "response.failed" || type === "response.incomplete" || type === "error") {
      throw new Error(
        extractCloudflareAiErrorMessage(record.response)
          ?? extractCloudflareAiErrorMessage(record)
          ?? `Migration planning AI stream ended with ${type}`,
      );
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (value) {
      buffer += decoder.decode(value, { stream: !done });
      let separatorIndex = findSseEventSeparator(buffer);
      while (separatorIndex !== -1) {
        const rawEvent = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + sseSeparatorLength(buffer, separatorIndex));
        consumeEvent(rawEvent);
        separatorIndex = findSseEventSeparator(buffer);
      }
    }
    if (done) break;
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    consumeEvent(buffer);
  }
  if (completedPayload !== undefined) return completedPayload;
  if (outputText) return { output_text: outputText };
  throw new Error("Migration planning AI stream ended without a completed response");
}

function findSseEventSeparator(buffer: string): number {
  const lf = buffer.indexOf("\n\n");
  const crlf = buffer.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

function sseSeparatorLength(buffer: string, index: number): number {
  return buffer.startsWith("\r\n\r\n", index) ? 4 : 2;
}

export function parseMigrationPlanningAiResult(result: unknown): MigrationAgentPlan {
  const text = extractMigrationPlanningStructuredText(result);
  if (!text) {
    throw new Error("Migration planning AI returned no structured output text");
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (error) {
    throw new Error(`Migration planning AI returned invalid structured output JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = migrationAgentPlanSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new Error(`Migration planning AI returned an invalid project plan: ${parsed.error.message}`);
  }
  return parsed.data;
}

function extractMigrationPlanningStructuredText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.output_text === "string") return record.output_text;
  if (typeof record.response === "string") return record.response;
  if (typeof record.text === "string") return record.text;
  if (typeof record.content === "string") return record.content;
  const result = record.result;
  if (result && typeof result === "object") {
    const nestedText = extractMigrationPlanningStructuredText(result);
    if (nestedText) return nestedText;
  }

  const output = record.output;
  if (Array.isArray(output)) {
    return output
      .map((item) => extractMigrationPlanningOutputText(item))
      .filter(Boolean)
      .join("");
  }

  const choices = record.choices;
  if (Array.isArray(choices)) {
    return choices
      .map((choice) => {
        if (!choice || typeof choice !== "object") return "";
        const message = (choice as Record<string, unknown>).message;
        return extractMigrationPlanningStructuredText(message);
      })
      .filter(Boolean)
      .join("");
  }

  return "";
}

function extractMigrationPlanningOutputText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  if (typeof record.text === "string") return record.text;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const partRecord = part as Record<string, unknown>;
        return typeof partRecord.text === "string" ? partRecord.text : "";
      })
      .join("");
  }
  return "";
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function extractCloudflareAiErrorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === "object") {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  const errors = record.errors;
  if (Array.isArray(errors)) {
    const messages = errors
      .map((item) => item && typeof item === "object" ? (item as Record<string, unknown>).message : undefined)
      .filter((message): message is string => typeof message === "string" && message.trim().length > 0);
    if (messages.length > 0) return messages.join("; ");
  }
  return null;
}

export function applyMigrationAgentPlan(
  plan: LegacyWorkspaceMigrationPlan,
  proposal: MigrationAgentPlan,
  options: { deployedApps?: MigrationDeployedAppContext[]; workerAppSourcePaths?: string[] } = {},
): LegacyWorkspaceMigrationPlan {
  const requiredPaths = new Set(plan.projects.flatMap((project) => project.sourcePaths));
  const seenPaths = new Set<string>();
  const usedNames = new Set<string>();
  const allowedApps = new Set((options.deployedApps ?? []).map((app) => app.scriptName));
  const seenApps = new Set<string>();
  const workerAppSourcePaths = new Set(options.workerAppSourcePaths ?? []);

  const projects = proposal.projects.flatMap((project) => {
    const uniqueSourcePaths: string[] = [];
    for (const sourcePath of project.sourcePaths) {
      if (!requiredPaths.has(sourcePath)) {
        throw new Error(`Migration planning agent returned unknown source path: ${sourcePath}`);
      }
      if (seenPaths.has(sourcePath)) {
        continue;
      }
      seenPaths.add(sourcePath);
      uniqueSourcePaths.push(sourcePath);
    }
    if (uniqueSourcePaths.length === 0) {
      return [];
    }
		const groupedWorkerAppPaths = uniqueSourcePaths.filter((sourcePath) => workerAppSourcePaths.has(sourcePath));
		if (groupedWorkerAppPaths.length > 0 && uniqueSourcePaths.length > groupedWorkerAppPaths.length) {
			throw new Error(`Migration planning agent grouped Worker app source paths with extra source paths: ${groupedWorkerAppPaths.join(", ")}`);
		}
		if (groupedWorkerAppPaths.length > 1) {
			throw new Error(`Migration planning agent grouped multiple Worker app source paths into one project: ${groupedWorkerAppPaths.join(", ")}`);
		}
    const proposedDeployedApps = Array.from(new Set(project.deployedApps ?? []));
    for (const appName of proposedDeployedApps) {
      if (!allowedApps.has(appName)) {
        throw new Error(`Migration planning agent returned unknown deployed app: ${appName}`);
      }
    }
    const deployedApps = proposedDeployedApps
      .filter((appName) => isSupportedDeployedAppAssociation(appName, uniqueSourcePaths, project.name, options.deployedApps ?? []));
    const uniqueDeployedApps: string[] = [];
    for (const appName of deployedApps) {
      if (seenApps.has(appName)) {
        continue;
      }
      seenApps.add(appName);
      uniqueDeployedApps.push(appName);
    }

    const baseName = normalizeProjectName(project.name);
    const name = uniqueNameFromSet(baseName || "project", usedNames);
    const description = sanitizeDescription(project.description);
    if (!description) {
      throw new Error(`Migration planning agent returned an empty description for ${name}`);
    }
    usedNames.add(name);
    return {
      name,
      description,
      sourcePaths: uniqueSourcePaths,
      ...(uniqueDeployedApps.length > 0 ? { deployedApps: uniqueDeployedApps } : {}),
      ignoreGlobs: LEGACY_IMPORT_IGNORE_GLOBS,
      reason: sanitizeDescription(project.reason) || "Migration planning agent grouped these legacy workspace paths.",
    };
  });

  const missingPaths = [];
  for (const sourcePath of requiredPaths) {
    if (!seenPaths.has(sourcePath)) {
      missingPaths.push(sourcePath);
    }
  }
  if (missingPaths.length > 0) {
    const existingMisc = projects.find((project) => isMiscProjectName(project.name));
    if (existingMisc) {
      existingMisc.sourcePaths.push(...missingPaths);
      existingMisc.reason = [
        existingMisc.reason,
        "Additional omitted paths were added automatically so every allowed legacy source path is migrated exactly once.",
      ].filter(Boolean).join(" ");
    } else {
      const miscName = uniqueNameFromSet("legacy-workspace-misc", usedNames);
      projects.push({
        name: miscName,
        description: "Miscellaneous legacy workspace paths preserved because the migration planning agent did not classify them.",
        sourcePaths: missingPaths,
        ignoreGlobs: LEGACY_IMPORT_IGNORE_GLOBS,
        reason: "Added automatically so every allowed legacy source path is migrated exactly once.",
      });
    }
  }

  return { ...plan, projects: coalesceMiscProjects(projects) };
}

function isSupportedDeployedAppAssociation(
  appName: string,
  sourcePaths: string[],
  projectName: string,
  deployedApps: MigrationDeployedAppContext[],
): boolean {
  const app = deployedApps.find((candidate) => candidate.scriptName === appName);
  if (!app) return false;
  const normalizedProjectName = normalizeProjectName(projectName);
  const sourceBasenames = new Set(sourcePaths.map((sourcePath) => normalizeProjectName(pathBasename(sourcePath))));
  if (app.configPath && sourcePaths.some((sourcePath) => isSameOrChildPath(app.configPath as string, sourcePath))) {
    return true;
  }
  if (app.projectId && normalizeProjectName(app.projectId) === normalizedProjectName) {
    return true;
  }
  return sourceBasenames.has(normalizeProjectName(app.scriptName));
}

function isSameOrChildPath(candidatePath: string, parentPath: string): boolean {
  const normalizedCandidate = normalizeAbsolutePath(candidatePath);
  const normalizedParent = normalizeAbsolutePath(parentPath);
  return normalizedCandidate === normalizedParent || normalizedCandidate.startsWith(`${normalizedParent}/`);
}

function normalizeAbsolutePath(path: string): string {
  const normalized = path.replace(/\/+/g, "/").replace(/\/$/, "");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function pathBasename(path: string): string {
  const normalized = normalizeAbsolutePath(path);
  return normalized.split("/").filter(Boolean).pop() || normalized;
}

export function appendUnclassifiedMiscProject(plan: LegacyWorkspaceMigrationPlan): LegacyWorkspaceMigrationPlan {
  const unclassified = Array.from(new Set(plan.unclassified ?? []));
  if (unclassified.length === 0) return { ...plan, projects: coalesceMiscProjects(plan.projects) };
  const existingMisc = plan.projects.find((project) => isMiscProjectName(project.name));
  if (existingMisc) {
    return {
      ...plan,
      projects: coalesceMiscProjects(plan.projects.map((project) => project === existingMisc
        ? {
            ...project,
            sourcePaths: Array.from(new Set([...project.sourcePaths, ...unclassified])),
            reason: [
              project.reason,
              "Additional hidden/tooling paths were preserved automatically.",
            ].filter(Boolean).join(" "),
          }
        : project)),
      unclassified: [],
    };
  }
  const existingNames = new Set(plan.projects.map((project) => project.name));
  const miscName = uniqueNameFromSet("legacy-workspace-misc", existingNames);
  return {
    ...plan,
    projects: coalesceMiscProjects([
      ...plan.projects,
      {
        name: miscName,
        description: "Miscellaneous hidden, cache, tooling, and loose legacy workspace paths preserved during migration.",
        sourcePaths: unclassified,
        ignoreGlobs: LEGACY_IMPORT_IGNORE_GLOBS,
        reason: "Preserved automatically outside the AI naming step so hidden/tooling paths are still migrated.",
      },
    ]),
    unclassified: [],
  };
}

export async function resetMigratedProjectsForWorkspace(input: {
  workspaceFs: LegacyWorkspaceMigrationWorkspaceResetter;
  runtime: LegacyWorkspaceMigrationRuntimeResetter;
  workspaceId: string;
}): Promise<{ deletedProjectIds: string[] }> {
  const projects = await input.workspaceFs.listProjects();
  const migratedProjectIds = Array.from(new Set(
    projects
      .filter((project) => project.migratedFrom?.workspaceId === input.workspaceId)
      .map((project) => project.id),
  ));

  for (const projectId of migratedProjectIds) {
    await input.runtime.deleteProject(projectId);
  }

  const cleanup = await input.workspaceFs.deleteMigratedProjectsForWorkspace(input.workspaceId);
  return { deletedProjectIds: cleanup.deleted.map((project) => project.id) };
}

function coalesceMiscProjects(projects: LegacyWorkspaceMigrationProjectPlan[]): LegacyWorkspaceMigrationProjectPlan[] {
  const firstMiscIndex = projects.findIndex((project) => isMiscProjectName(project.name));
  if (firstMiscIndex < 0) return projects;
  const miscProjects = projects.filter((project) => isMiscProjectName(project.name));
  if (miscProjects.length <= 1) {
    return projects.map((project, index) => index === firstMiscIndex ? { ...project, name: "legacy-workspace-misc" } : project);
  }
  const mergedMisc: LegacyWorkspaceMigrationProjectPlan = {
    ...projects[firstMiscIndex],
    name: "legacy-workspace-misc",
    description: "Miscellaneous hidden, cache, tooling, loose, and unclassified legacy workspace paths preserved during migration.",
    sourcePaths: Array.from(new Set(miscProjects.flatMap((project) => project.sourcePaths))),
    ignoreGlobs: LEGACY_IMPORT_IGNORE_GLOBS,
    reason: miscProjects.map((project) => project.reason).filter(Boolean).join(" "),
  };
  return projects.flatMap((project, index) => {
    if (!isMiscProjectName(project.name)) return [project];
    return index === firstMiscIndex ? [mergedMisc] : [];
  });
}

function isMiscProjectName(name: string): boolean {
  const normalized = normalizeProjectName(name);
  return normalized === "misc" ||
    normalized === "legacy-workspace-misc" ||
    normalized === "leftovers" ||
    normalized === "unclassified" ||
    normalized.startsWith("legacy-workspace-misc-");
}

export function buildLegacyWorkspaceMigrationDiagnostics(input: {
  legacyRoot: string;
  legacyFileCount: number;
  deployedApps?: MigrationDeployedAppContext[];
}): LegacyWorkspaceMigrationDiagnostics {
  const deployedApps = input.deployedApps ?? [];
  const diagnostics: LegacyWorkspaceMigrationDiagnostics = {
    legacyRoot: input.legacyRoot,
    legacyFileCount: input.legacyFileCount,
    deployedAppCount: deployedApps.length,
    deployedAppNames: deployedApps.map((app) => app.scriptName).slice(0, 100),
  };
  const warnings: string[] = [];
  if (input.legacyFileCount === 0 && deployedApps.length > 0) {
    warnings.push(
      `No legacy files were found under ${input.legacyRoot}, but ${deployedApps.length} deployed app record(s) are still associated with this workspace. The migration source is probably not connected to the legacy sandbox storage.`,
    );
  }
  if (deployedApps.some((app) => app.projectId)) {
    warnings.push("Some deployed apps are already associated with projects and may not need legacy migration.");
  }
  if (warnings.length > 0) diagnostics.warnings = warnings;
  return diagnostics;
}

function toMigrationDeployedAppContext(script: WorkerScript): MigrationDeployedAppContext {
  return {
    scriptName: script.script_name,
    configPath: script.config_path,
    projectId: script.project_id,
    updatedAt: script.updated_at,
    isPublic: script.is_public,
  };
}

function looksLikeTextContextFile(path: string): boolean {
  const name = path.split("/").pop()?.toLowerCase() ?? path.toLowerCase();
  if (TEXT_CONTEXT_FILE_NAMES.has(name)) return true;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return false;
  return TEXT_CONTEXT_FILE_EXTENSIONS.has(name.slice(dot));
}

function isSensitiveNamingPath(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  return SENSITIVE_CONTEXT_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function sanitizeNamingSample(text: string | null): string {
  if (!text) return "";
  return text
    .replace(/\0/g, "")
    .split(/\r?\n/)
    .map((line) => {
      if (/(password|passwd|secret|token|credential|private[-_ ]?key|api[-_ ]?key)\s*[:=]/i.test(line)) {
        return "[redacted sensitive-looking line]";
      }
      return line;
    })
    .join("\n")
    .trim()
    .slice(0, NAMING_CONTEXT_MAX_SAMPLE_BYTES);
}

function sanitizeDescription(value: string | undefined): string {
  return (value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, DESCRIPTION_MAX_LENGTH);
}

function uniqueNameFromSet(base: string, existing: Set<string>): string {
  const normalized = normalizeProjectName(base);
  if (!existing.has(normalized)) return normalized;
  for (let index = 2; index < 100; index++) {
    const suffix = `-${index}`;
    const candidate = `${normalized.slice(0, 48 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${normalized.slice(0, 40)}-${crypto.randomUUID().slice(0, 7)}`;
}

function normalizeProjectName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "legacy-project";
}

function uniqueProjectName(base: string, projects: LegacyWorkspaceMigrationProjectPlan[]): string {
  const existing = new Set(projects.map((project) => project.name));
  if (!existing.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 48 - suffix.length)}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
  return `${base.slice(0, 40)}-${crypto.randomUUID().slice(0, 7)}`;
}

function isPlanningOnlyPath(name: string): boolean {
  return name.startsWith(".");
}

function joinLegacyPath(root: string, path: string): string {
  const cleanRoot = root.replace(/\/+$/, "");
  const cleanPath = path.replace(/^\/+/, "");
  return `${cleanRoot}/${cleanPath}`;
}
