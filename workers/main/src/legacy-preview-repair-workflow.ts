import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { z } from "zod";
import type { AdminThreadListRow } from "./admin-index-types.js";
import type { PreviewTarget } from "./chat-thread-do.js";
import type { Env } from "./types.js";
import {
  WorkspaceFilesystemClient,
  type LegacyWorkspaceMigrationPlan,
} from "./workspace-filesystem-do.js";

const LEGACY_ROOT = "/home/claude";
const NEW_PROJECT_ROOT = "/workspace";
const THREAD_BATCH_SIZE = 100;
const THREAD_REPAIR_CONCURRENCY = 8;
const THREAD_PREVIEW_FETCH_TIMEOUT_MS = 15_000;

const previewRepairPayloadSchema = z.object({
  workspaceId: z.string().min(1),
  orgId: z.string().min(1),
  requestedBy: z.string().optional(),
  dryRun: z.boolean().optional().default(false),
  threadIds: z.array(z.string().min(1)).optional(),
});

export type LegacyPreviewRepairPayload = z.infer<typeof previewRepairPayloadSchema>;

type PreviewState = {
  target: PreviewTarget | null;
  tabs: PreviewTarget[];
  activeTabId: string | null;
  version?: number;
};

type PreviewRepairMapping = {
  project: string;
  oldAbsolutePath: string;
  newPath: string;
  sourcePath: string;
  sourcePathLength: number;
};

type PreviewRepairDecision =
  | { status: "unchanged"; target: PreviewTarget; reason?: string }
  | { status: "repaired"; target: PreviewTarget; from: PreviewTarget; mapping: PreviewRepairMapping }
  | { status: "ambiguous"; target: PreviewTarget; candidates: PreviewRepairMapping[] };

export type PreviewRepairThreadResult = {
  threadId: string;
  changed: boolean;
  repaired: number;
  ambiguous: number;
  skipped: number;
  beforeTabs: number;
  afterTabs: number;
  error?: string;
};

export type LegacyPreviewRepairResult = {
  success: boolean;
  dryRun: boolean;
  workspaceId: string;
  orgId: string;
  threadsScanned: number;
  threadsChanged: number;
  targetsRepaired: number;
  ambiguousTargets: number;
  skippedTargets: number;
  threadResults: PreviewRepairThreadResult[];
};

export class LegacyPreviewRepairWorkflow extends WorkflowEntrypoint<Env, LegacyPreviewRepairPayload> {
  override async run(
    event: WorkflowEvent<LegacyPreviewRepairPayload>,
    step: WorkflowStep,
  ): Promise<LegacyPreviewRepairResult> {
    const payload = previewRepairPayloadSchema.parse(event.payload);
    const workspaceFs = new WorkspaceFilesystemClient(this.env as never, payload.workspaceId);

    const migrationState = await step.do("load-migration-state", async () => {
      return workspaceFs.getLegacyWorkspaceMigrationState();
    });
    if (migrationState.status !== "complete" || !migrationState.plan) {
      throw new Error(`Workspace migration is not complete; current status is ${migrationState.status}`);
    }

    const remapIndex = await step.do("build-preview-remap-index", async () => {
      return buildPreviewRepairIndex(migrationState.plan ?? { projects: [] });
    });

    const threadIds = await step.do("list-workspace-threads", async () => {
      if (payload.threadIds?.length) {
        return Array.from(new Set(payload.threadIds.map((id) => id.trim()).filter(Boolean)));
      }
      return listWorkspaceThreadIds(this.env, payload.workspaceId);
    });

    const results: PreviewRepairThreadResult[] = [];
    for (let index = 0; index < threadIds.length; index += THREAD_REPAIR_CONCURRENCY) {
      const batch = threadIds.slice(index, index + THREAD_REPAIR_CONCURRENCY);
      const batchResults = await step.do(`repair-thread-batch-${Math.floor(index / THREAD_REPAIR_CONCURRENCY) + 1}`, async () => {
        return Promise.all(batch.map((threadId) => repairThreadPreviewState({
          env: this.env,
          workspaceId: payload.workspaceId,
          threadId,
          remapIndex,
          dryRun: payload.dryRun === true,
        })));
      });
      results.push(...batchResults);
    }

    const interestingResults = results.filter((result) => (
      result.changed || result.ambiguous > 0 || Boolean(result.error)
    ));
    const summary: LegacyPreviewRepairResult = {
      success: true,
      dryRun: payload.dryRun === true,
      workspaceId: payload.workspaceId,
      orgId: payload.orgId,
      threadsScanned: results.length,
      threadsChanged: results.filter((result) => result.changed).length,
      targetsRepaired: results.reduce((sum, result) => sum + result.repaired, 0),
      ambiguousTargets: results.reduce((sum, result) => sum + result.ambiguous, 0),
      skippedTargets: results.reduce((sum, result) => sum + result.skipped, 0),
      threadResults: interestingResults,
    };
    console.log("[legacy-preview-repair] completed", summary);
    return summary;
  }
}

async function listWorkspaceThreadIds(env: Env, workspaceId: string): Promise<string[]> {
  if (!env.APP_DB) {
    throw new Error("APP_DB binding is required to list workspace threads for preview repair");
  }

  const ids: string[] = [];
  let offset = 0;
  for (;;) {
    const page = await env.APP_DB.prepare(
      "SELECT id FROM threads WHERE workspace_id = ? ORDER BY updated_at DESC, id ASC LIMIT ? OFFSET ?",
    ).bind(workspaceId, THREAD_BATCH_SIZE, offset).all<Pick<AdminThreadListRow, "id">>();
    const rows = page.results ?? [];
    ids.push(...rows.map((row) => row.id).filter(Boolean));
    if (rows.length < THREAD_BATCH_SIZE) break;
    offset += rows.length;
  }
  return ids;
}

async function repairThreadPreviewState(input: {
  env: Env;
  workspaceId: string;
  threadId: string;
  remapIndex: PreviewRepairMapping[];
  dryRun: boolean;
}): Promise<PreviewRepairThreadResult> {
  try {
    const stub = input.env.CHAT_THREAD.get(input.env.CHAT_THREAD.idFromName(input.threadId));
    const response = await fetchWithTimeout(
      stub,
      new Request("http://internal/preview", { method: "GET" }),
      THREAD_PREVIEW_FETCH_TIMEOUT_MS,
    );
    if (!response.ok) {
      throw new Error(await response.text() || `Preview state read failed: ${response.status}`);
    }
    const state = await response.json() as PreviewState;
    const repair = repairLegacyPreviewState(state, input.workspaceId, input.remapIndex);
    if (repair.changed && !input.dryRun) {
      const writeResponse = await fetchWithTimeout(
        stub,
        new Request("http://internal/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            tabs: repair.tabs,
            activeTabId: repair.activeTabId,
          }),
        }),
        THREAD_PREVIEW_FETCH_TIMEOUT_MS,
      );
      if (!writeResponse.ok) {
        throw new Error(await writeResponse.text() || `Preview state write failed: ${writeResponse.status}`);
      }
    }
    return {
      threadId: input.threadId,
      changed: repair.changed,
      repaired: repair.repaired,
      ambiguous: repair.ambiguous,
      skipped: repair.skipped,
      beforeTabs: repair.beforeTabs,
      afterTabs: repair.tabs.length,
    };
  } catch (error) {
    return {
      threadId: input.threadId,
      changed: false,
      repaired: 0,
      ambiguous: 0,
      skipped: 0,
      beforeTabs: 0,
      afterTabs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function fetchWithTimeout(
  stub: DurableObjectStub,
  request: Request,
  timeoutMs: number,
): Promise<Response> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      stub.fetch(request),
      new Promise<Response>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`Preview state request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

export function buildPreviewRepairIndex(plan: LegacyWorkspaceMigrationPlan): PreviewRepairMapping[] {
  const mappings: PreviewRepairMapping[] = [];
  for (const project of plan.projects ?? []) {
    for (const sourcePath of project.sourcePaths ?? []) {
      const normalizedSourcePath = normalizeLegacyAbsolutePath(sourcePath);
      if (!normalizedSourcePath) continue;
      mappings.push({
        project: project.name,
        oldAbsolutePath: normalizedSourcePath,
        newPath: "",
        sourcePath: normalizedSourcePath,
        sourcePathLength: normalizedSourcePath.length,
      });
    }
  }
  return mappings.sort((a, b) => b.sourcePathLength - a.sourcePathLength);
}

export function repairLegacyPreviewState(
  state: PreviewState,
  workspaceId: string,
  remapIndex: PreviewRepairMapping[],
): {
  changed: boolean;
  tabs: PreviewTarget[];
  activeTabId: string | null;
  repaired: number;
  ambiguous: number;
  skipped: number;
  beforeTabs: number;
} {
  const originalTabs = Array.isArray(state.tabs) && state.tabs.length > 0
    ? state.tabs
    : state.target
      ? [state.target]
      : [];
  const decisions = originalTabs.map((target) => repairPreviewTarget(target, workspaceId, remapIndex));
  const tabs = decisions.map((decision) => decision.target);
  const changed = decisions.some((decision) => decision.status === "repaired");
  const repaired = decisions.filter((decision) => decision.status === "repaired").length;
  const ambiguous = decisions.filter((decision) => decision.status === "ambiguous").length;
  const skipped = decisions.filter((decision) => decision.status === "unchanged").length;
  const activeTabId = remapActiveTabId(state.activeTabId, originalTabs, tabs);

  return {
    changed,
    tabs,
    activeTabId,
    repaired,
    ambiguous,
    skipped,
    beforeTabs: originalTabs.length,
  };
}

function repairPreviewTarget(
  target: PreviewTarget,
  workspaceId: string,
  remapIndex: PreviewRepairMapping[],
): PreviewRepairDecision {
  if (target.kind !== "file" || target.source !== "workspace" || target.workspaceId !== workspaceId) {
    return { status: "unchanged", target };
  }

  const oldAbsolutePath = workspacePreviewPathToLegacyAbsolutePath(target.path);
  if (!oldAbsolutePath) {
    return { status: "unchanged", target, reason: "not_legacy_workspace_path" };
  }
  const candidates = findPreviewRepairMappings(oldAbsolutePath, remapIndex);
  if (candidates.length === 0) {
    return { status: "unchanged", target, reason: "no_mapping" };
  }
  if (candidates.length > 1) {
    return { status: "ambiguous", target, candidates };
  }

  const mapping = candidates[0]!;
  return {
    status: "repaired",
    from: target,
    mapping,
    target: {
      ...target,
      source: "vm",
      project: mapping.project,
      path: mapping.newPath,
      filename: target.filename ?? basename(mapping.newPath),
    },
  };
}

function findPreviewRepairMappings(
  oldAbsolutePath: string,
  remapIndex: PreviewRepairMapping[],
): PreviewRepairMapping[] {
  const candidates: PreviewRepairMapping[] = [];
  let bestLength = -1;
  for (const mapping of remapIndex) {
    const newPath = mapLegacyPathToProjectPath(oldAbsolutePath, mapping.sourcePath);
    if (!newPath) continue;
    if (mapping.sourcePathLength < bestLength) break;
    if (mapping.sourcePathLength > bestLength) {
      candidates.length = 0;
      bestLength = mapping.sourcePathLength;
    }
    candidates.push({ ...mapping, newPath });
  }
  return candidates;
}

function mapLegacyPathToProjectPath(oldAbsolutePath: string, sourcePath: string): string | null {
  if (oldAbsolutePath === sourcePath) {
    return `${NEW_PROJECT_ROOT}/${basename(oldAbsolutePath)}`;
  }
  if (!oldAbsolutePath.startsWith(`${sourcePath}/`)) {
    return null;
  }
  const relativePath = oldAbsolutePath.slice(sourcePath.length + 1);
  if (!relativePath || relativePath.includes("..")) {
    return null;
  }
  return `${NEW_PROJECT_ROOT}/${relativePath}`;
}

function workspacePreviewPathToLegacyAbsolutePath(path: string): string | null {
  const normalized = normalizeSlashPath(path);
  if (!normalized || normalized.includes("..")) return null;
  if (normalized === LEGACY_ROOT || normalized.startsWith(`${LEGACY_ROOT}/`)) {
    return normalized;
  }
  if (normalized === NEW_PROJECT_ROOT || normalized.startsWith(`${NEW_PROJECT_ROOT}/`)) {
    return `${LEGACY_ROOT}${normalized.slice(NEW_PROJECT_ROOT.length) || "/"}`;
  }
  return `${LEGACY_ROOT}${normalized.startsWith("/") ? "" : "/"}${normalized}`;
}

function normalizeLegacyAbsolutePath(path: string): string | null {
  const normalized = normalizeSlashPath(path);
  if (!normalized || normalized.includes("..")) return null;
  if (normalized === LEGACY_ROOT || normalized.startsWith(`${LEGACY_ROOT}/`)) {
    return normalized;
  }
  return null;
}

function normalizeSlashPath(path: string): string {
  const value = path.trim().replace(/\\/g, "/");
  if (!value) return "";
  const parts = value.split("/").filter((part) => part && part !== ".");
  return `/${parts.join("/")}`;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

function remapActiveTabId(
  activeTabId: string | null,
  originalTabs: PreviewTarget[],
  tabs: PreviewTarget[],
): string | null {
  if (tabs.length === 0) return null;
  if (!activeTabId) return getPreviewTabId(tabs[0]!);
  const index = originalTabs.findIndex((target) => getPreviewTabId(target) === activeTabId);
  return getPreviewTabId(tabs[index >= 0 ? index : 0]!);
}

function getPreviewTabId(target: PreviewTarget): string {
  if (target.kind === "app") {
    return `app:${target.scriptName}`;
  }
  if (target.kind === "runtime_artifact") {
    return `artifact:${target.artifact.id}`;
  }
  return `file:${target.workspaceId}:${target.source}:${target.project ?? ""}:${target.path}`;
}
