import { DurableObject } from "cloudflare:workers";
import { wrapWorkflowBinding } from "@cloudflare/dynamic-workflows";
import type { OrgDO, OrgThread } from "./auth";
import type {
  ChatThreadDO,
  InitialUserMessageRequest,
  InitialUserMessageResult,
} from "./chat-thread-do";
import {
  getCronMinimumIntervalMs,
  getNextCronRunAt,
  parseCronExpression,
} from "./cron-schedule";
import type { WorkspaceDO } from "./workspace";
import {
  getDefaultLlmModel,
} from "../../../src/lib/llm-provider-config";
import { resolveModelPickerCatalog } from "../../../src/lib/model-catalog";
import {
  resolveDefaultModelForChat,
  resolveEffectivePickerConfig,
} from "../../../src/lib/model-picker-config";
import { getBillingPlanLimits } from "../../../src/lib/billing-plans";
import type { LlmModel } from "../../../src/types";
import {
  getOrgModelPickerConfigCompat,
  getWorkspaceModelPickerConfigCompat,
} from "./model-picker-config-compat";

const MAX_DUE_JOBS_PER_ALARM = 20;
const WORKSPACE_ID_KEY = "workspaceId";
const AUTOMATION_WORKFLOW_BINDING = "DETERMINISTIC_AUTOMATION_WORKFLOWS";

function formatInterval(ms: number): string {
  if (ms % (24 * 60 * 60 * 1000) === 0) {
    const days = ms / (24 * 60 * 60 * 1000);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (ms % (60 * 60 * 1000) === 0) {
    const hours = ms / (60 * 60 * 1000);
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.round(ms / (60 * 1000));
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

type RunStatus = "success" | "busy" | "question" | "error";
type DeterministicAutomationRunStatus = "started" | "error";

interface ScheduledPromptRow {
  id: string;
  name: string;
  prompt: string;
  cron_expression: string;
  thread_id: string;
  scheduled_by_thread_id: string | null;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
  run_count: number;
}

interface DeterministicAutomationRow {
  id: string;
  name: string;
  description: string | null;
  source: string;
  source_version: number;
  cron_expression: string;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: string | null;
  last_run_error: string | null;
  last_instance_id: string | null;
  run_count: number;
}

interface DeterministicAutomationVersionRow {
  automation_id: string;
  workspace_id: string;
  source_version: number;
  source: string;
  created_by: string;
  created_at: number;
}

interface WorkspaceInfo {
  id: string;
  org_id: string;
  archived: boolean;
}

export interface WorkspaceAutomationInfo {
  id: string;
  org_id: string;
}

interface DispatchResult {
  status: RunStatus;
  error?: string;
  threadId: string;
}

type InitialUserMessageRpc = {
  startInitialUserMessage: (
    body: InitialUserMessageRequest,
  ) => Promise<InitialUserMessageResult>;
};

interface DeterministicAutomationDispatchResult {
  status: DeterministicAutomationRunStatus;
  instanceId?: string;
  error?: string;
}

export interface WorkspaceScheduledPrompt {
  id: string;
  name: string;
  prompt: string;
  cron_expression: string;
  thread_id: string;
  scheduled_by_thread_id: string | null;
  enabled: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: RunStatus | null;
  last_run_error: string | null;
  run_count: number;
}

export interface WorkspaceDeterministicAutomation {
  id: string;
  name: string;
  description: string | null;
  source: string;
  source_version: number;
  cron_expression: string;
  enabled: boolean;
  created_by: string;
  created_at: number;
  updated_at: number;
  next_run_at: number | null;
  last_run_at: number | null;
  last_run_status: DeterministicAutomationRunStatus | null;
  last_run_error: string | null;
  last_instance_id: string | null;
  run_count: number;
}

export interface CreateScheduledPromptInput {
  workspaceId: string;
  name: string;
  prompt: string;
  cronExpression: string;
  createdBy: string;
  scheduledByThreadId?: string | null;
  enabled?: boolean;
}

export interface CreateDeterministicAutomationInput {
  workspaceId: string;
  name: string;
  source: string;
  cronExpression: string;
  createdBy: string;
  description?: string | null;
  enabled?: boolean;
}

export interface UpdateScheduledPromptInput {
  workspaceId: string;
  id: string;
  name?: string;
  prompt?: string;
  cronExpression?: string;
  enabled?: boolean;
}

export interface UpdateDeterministicAutomationInput {
  workspaceId: string;
  id: string;
  name?: string;
  description?: string | null;
  source?: string;
  cronExpression?: string;
  enabled?: boolean;
}

export interface RunScheduledPromptNowResult {
  prompt: WorkspaceScheduledPrompt;
  dispatch: {
    status: RunStatus;
    thread_id: string;
    error?: string;
      };
}

export interface RunDeterministicAutomationNowResult {
  automation: WorkspaceDeterministicAutomation;
  dispatch: {
    status: DeterministicAutomationRunStatus;
    instance_id?: string;
    error?: string;
  };
}

export interface DeterministicAutomationSourceSnapshot {
  automation_id: string;
  workspace_id: string;
  source_version: number;
  source: string;
  created_by: string;
}

export interface ValidateDeterministicAutomationResult {
  valid: boolean;
  errors: string[];
}

export interface WorkspaceCronEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  CODE_MODE_LOADER?: WorkerLoader;
  DETERMINISTIC_AUTOMATION_WORKFLOWS?: Workflow;
}

export class WorkspaceCronDO extends DurableObject<WorkspaceCronEnv> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: WorkspaceCronEnv) {
    super(ctx, env);
    this.sql = ctx.storage.sql;

    ctx.blockConcurrencyWhile(async () => {
      this.migrate();
    });
  }

  private migrate(): void {
    const version = this.ctx.storage.kv.get<number>("schemaVersion") ?? 0;
    if (version < 1) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS scheduled_prompts (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          prompt TEXT NOT NULL,
          cron_expression TEXT NOT NULL,
          thread_id TEXT NOT NULL,
          scheduled_by_thread_id TEXT,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_run_status TEXT,
          last_run_error TEXT,
          run_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_next_run ON scheduled_prompts(enabled, next_run_at)",
      );
    }

    if (version >= 1 && version < 2) {
      this.sql.exec(
        "ALTER TABLE scheduled_prompts ADD COLUMN scheduled_by_thread_id TEXT",
      );
    }

    if (version < 2) {
      this.ctx.storage.kv.put("schemaVersion", 2);
    }

    if (version < 3) {
      this.sql.exec(`
        CREATE TABLE IF NOT EXISTS deterministic_automations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT,
          source TEXT NOT NULL,
          source_version INTEGER NOT NULL DEFAULT 1,
          cron_expression TEXT NOT NULL,
          enabled INTEGER NOT NULL DEFAULT 1,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          next_run_at INTEGER,
          last_run_at INTEGER,
          last_run_status TEXT,
          last_run_error TEXT,
          last_instance_id TEXT,
          run_count INTEGER NOT NULL DEFAULT 0
        )
      `);
      this.sql.exec(
        `CREATE TABLE IF NOT EXISTS deterministic_automation_versions (
          automation_id TEXT NOT NULL,
          workspace_id TEXT NOT NULL,
          source_version INTEGER NOT NULL,
          source TEXT NOT NULL,
          created_by TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (automation_id, source_version)
        )`,
      );
      this.sql.exec(
        "CREATE INDEX IF NOT EXISTS idx_deterministic_automations_next_run ON deterministic_automations(enabled, next_run_at)",
      );
      this.ctx.storage.kv.put("schemaVersion", 3);
    }
  }

  private normalizeWorkspaceId(workspaceId: string): string {
    const normalized = workspaceId.trim();
    if (!normalized) {
      throw new Error("workspaceId is required");
    }
    return normalized;
  }

  private assertWorkspaceIdentity(workspaceId: string): string {
    const normalized = this.normalizeWorkspaceId(workspaceId);
    const storedWorkspaceId = this.ctx.storage.kv.get<string>(WORKSPACE_ID_KEY);
    if (!storedWorkspaceId) {
      this.ctx.storage.kv.put(WORKSPACE_ID_KEY, normalized);
      return normalized;
    }
    if (storedWorkspaceId !== normalized) {
      throw new Error("Workspace scheduler context mismatch");
    }
    return normalized;
  }

  private getStoredWorkspaceId(): string | null {
    const workspaceId = this.ctx.storage.kv.get<string>(WORKSPACE_ID_KEY);
    if (!workspaceId || !workspaceId.trim()) return null;
    return workspaceId.trim();
  }

  private toPrompt(row: ScheduledPromptRow): WorkspaceScheduledPrompt {
    return {
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      cron_expression: row.cron_expression,
      thread_id: row.thread_id,
      scheduled_by_thread_id: row.scheduled_by_thread_id,
      enabled: row.enabled === 1,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_run_status: (row.last_run_status as RunStatus | null) ?? null,
      last_run_error: row.last_run_error,
      run_count: row.run_count,
    };
  }

  private toAutomation(
    row: DeterministicAutomationRow,
  ): WorkspaceDeterministicAutomation {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      source: row.source,
      source_version: row.source_version,
      cron_expression: row.cron_expression,
      enabled: row.enabled === 1,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      next_run_at: row.next_run_at,
      last_run_at: row.last_run_at,
      last_run_status:
        (row.last_run_status as DeterministicAutomationRunStatus | null) ??
        null,
      last_run_error: row.last_run_error,
      last_instance_id: row.last_instance_id,
      run_count: row.run_count,
    };
  }

  private parseName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("name is required");
    }
    if (trimmed.length > 120) {
      throw new Error("name must be 120 characters or fewer");
    }
    return trimmed;
  }

  private parsePrompt(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error("prompt is required");
    }
    if (trimmed.length > 20_000) {
      throw new Error("prompt must be 20000 characters or fewer");
    }
    return trimmed;
  }

  private parseDescription(value: string | null | undefined): string | null {
    if (value == null) return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (trimmed.length > 500) {
      throw new Error("description must be 500 characters or fewer");
    }
    return trimmed;
  }

  private parseAutomationSource(value: string): string {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error("source is required");
    }
    if (value.length > 100_000) {
      throw new Error("source must be 100000 characters or fewer");
    }
    return value;
  }

  private parseOptionalThreadId(
    value: string | null | undefined,
  ): string | null {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeCronExpression(value: string): string {
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (!trimmed) {
      throw new Error("cronExpression is required");
    }
    if (trimmed.length > 100) {
      throw new Error("cronExpression must be 100 characters or fewer");
    }
    parseCronExpression(trimmed);
    return trimmed;
  }

  private getPromptRow(id: string): ScheduledPromptRow | null {
    const rows = this.sql
      .exec("SELECT * FROM scheduled_prompts WHERE id = ?", id)
      .toArray() as unknown as ScheduledPromptRow[];
    return rows[0] ?? null;
  }

  private getAutomationRow(id: string): DeterministicAutomationRow | null {
    const rows = this.sql
      .exec("SELECT * FROM deterministic_automations WHERE id = ?", id)
      .toArray() as unknown as DeterministicAutomationRow[];
    return rows[0] ?? null;
  }

  private insertAutomationVersion(
    workspaceId: string,
    automationId: string,
    sourceVersion: number,
    source: string,
    createdBy: string,
    createdAt: number,
  ): void {
    this.sql.exec(
      `INSERT OR REPLACE INTO deterministic_automation_versions
       (automation_id, workspace_id, source_version, source, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      automationId,
      workspaceId,
      sourceVersion,
      source,
      createdBy,
      createdAt,
    );
  }

  private async getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo> {
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspaceId),
    ) as DurableObjectStub<WorkspaceDO>;
    const info = await workspaceStub.getInfo();
    if (!info || info.archived) {
      throw new Error("Workspace not found or archived");
    }
    return {
      id: info.id,
      org_id: info.org_id,
      archived: info.archived,
    };
  }

  async getWorkspaceInfoForAutomation(
    workspaceId: string,
  ): Promise<WorkspaceAutomationInfo> {
    this.assertWorkspaceIdentity(workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    return {
      id: workspace.id,
      org_id: workspace.org_id,
    };
  }

  private getOrgStub(orgId: string): DurableObjectStub<OrgDO> {
    return this.env.ORG.get(
      this.env.ORG.idFromName(orgId),
    ) as DurableObjectStub<OrgDO>;
  }

  private async resolveDefaultThreadModel(
    workspace: WorkspaceInfo,
  ): Promise<LlmModel> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspace.id),
    ) as DurableObjectStub<WorkspaceDO>;
    const [
      llmProviderConfig,
      experimentalSettings,
      orgPickerConfig,
      workspacePickerConfig,
    ] = await Promise.all([
      orgStub.getLlmProviderConfig(),
      orgStub.getExperimentalSettings(),
      getOrgModelPickerConfigCompat(orgStub),
      getWorkspaceModelPickerConfigCompat(workspaceStub),
    ]);
    const effectiveConfig = resolveEffectivePickerConfig(
      orgPickerConfig,
      workspacePickerConfig,
    );
    const visibleCatalog = resolveModelPickerCatalog({
      effectiveConfig,
      experimentalSettings,
      orgProvider: llmProviderConfig?.provider,
    });
    const model = resolveDefaultModelForChat({
      effectiveDefaultModel: effectiveConfig.default_model,
      fallbackModel: getDefaultLlmModel(llmProviderConfig?.provider),
      visibleCatalog,
    });
    if (!model) {
      throw new Error("No models are available");
    }
    return model;
  }

  private async assertCronWithinBillingLimits(
    workspace: WorkspaceInfo,
    cronExpression: string,
    createdBy: string,
    existingPromptId?: string,
  ): Promise<void> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const org = await orgStub.getInfo();
    const limits = getBillingPlanLimits(org?.billing_plan, org?.billing_status);
    const minIntervalMs = limits.minCronIntervalMs;
    if (minIntervalMs !== null) {
      const actualIntervalMs = getCronMinimumIntervalMs(cronExpression);
      if (actualIntervalMs !== null && actualIntervalMs < minIntervalMs) {
        throw new Error(
          `Your current billing plan allows cron jobs no more frequent than every ${formatInterval(minIntervalMs)}.`,
        );
      }
    }

    if (limits.maxCronJobsPerUser !== null) {
      const scheduledPromptCount =
        this.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM scheduled_prompts
           WHERE created_by = ? AND id != ?`,
            createdBy,
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const automationCount =
        this.sql
          .exec<{ count: number }>(
            `SELECT COUNT(*) AS count FROM deterministic_automations
           WHERE created_by = ? AND id != ?`,
            createdBy,
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const count = scheduledPromptCount + automationCount;
      if (count >= limits.maxCronJobsPerUser) {
        throw new Error(
          `Your current billing plan allows ${limits.maxCronJobsPerUser} cron jobs per user.`,
        );
      }
      return;
    }

    if (limits.maxCronJobsPerWorkspace !== null) {
      const scheduledPromptCount =
        this.sql
          .exec<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM scheduled_prompts WHERE id != ?",
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const automationCount =
        this.sql
          .exec<{
            count: number;
          }>(
            "SELECT COUNT(*) AS count FROM deterministic_automations WHERE id != ?",
            existingPromptId ?? "",
          )
          .toArray()[0]?.count ?? 0;
      const count = scheduledPromptCount + automationCount;
      if (count >= limits.maxCronJobsPerWorkspace) {
        throw new Error(
          `Your current billing plan allows ${limits.maxCronJobsPerWorkspace} cron jobs per workspace.`,
        );
      }
    }
  }

  private async createInitialThreadForPrompt(
    workspace: WorkspaceInfo,
    name: string,
    prompt: string,
    createdBy: string,
  ): Promise<string> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const model = await this.resolveDefaultThreadModel(workspace);
    const created = (await orgStub.createThread(
      workspace.id,
      `Scheduled: ${name}`,
      createdBy || "system",
      prompt.slice(0, 500),
      model,
    )) as OrgThread;
    return created.id;
  }

  private async ensureRunnableThread(
    prompt: WorkspaceScheduledPrompt,
    workspace: WorkspaceInfo,
  ): Promise<string> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const existing = (await orgStub.getThread(
      prompt.thread_id,
    )) as OrgThread | null;
    if (existing && existing.workspace_id === workspace.id) {
      return prompt.thread_id;
    }

    const model = await this.resolveDefaultThreadModel(workspace);
    const created = (await orgStub.createThread(
      workspace.id,
      `Scheduled: ${prompt.name}`,
      "system",
      prompt.prompt.slice(0, 500),
      model,
    )) as OrgThread;

    this.sql.exec(
      "UPDATE scheduled_prompts SET thread_id = ?, updated_at = ? WHERE id = ?",
      created.id,
      Date.now(),
      prompt.id,
    );
    return created.id;
  }

  private buildScheduledMessage(
    prompt: WorkspaceScheduledPrompt,
    scheduledForMs: number,
  ): string {
    const scheduledForIso = new Date(scheduledForMs).toISOString();
    const originThreadId = prompt.scheduled_by_thread_id ?? "unknown";
    return [
      `<camelai system message>Scheduled prompt "${prompt.name}" fired at ${scheduledForIso} UTC. Origin scheduler thread/session id: ${originThreadId}. Use this id to search prior context from when this cron was created.</camelai system message>`,
      prompt.prompt,
    ].join("\n\n");
  }

  private async dispatchPrompt(
    prompt: WorkspaceScheduledPrompt,
    workspace: WorkspaceInfo,
    scheduledForMs: number,
  ): Promise<DispatchResult> {
    const threadId = await this.ensureRunnableThread(prompt, workspace);
    const chatThreadStub = this.env.CHAT_THREAD.get(
      this.env.CHAT_THREAD.idFromName(threadId),
    ) as unknown as InitialUserMessageRpc;

    try {
      const payload = await chatThreadStub.startInitialUserMessage({
        threadId,
        workspaceId: workspace.id,
        orgId: workspace.org_id,
        userName: "Scheduler",
        message: this.buildScheduledMessage(prompt, scheduledForMs),
      });
      switch (payload.status) {
        case "accepted":
          return {
            status: "success",
            threadId,
          };
        case "busy":
          return {
            status: "busy",
            error: "Thread is busy with another run",
            threadId,
          };
        case "error":
          return {
            status: "error",
            error:
              typeof payload.error === "string"
                ? payload.error
                : "Unknown chat error",
            threadId,
          };
        default:
          return {
            status: "error",
            error: "Unexpected response from chat thread",
            threadId,
          };
      }
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
        threadId,
      };
    }
  }

  async validateDeterministicAutomationSource(
    source: string,
  ): Promise<ValidateDeterministicAutomationResult> {
    const errors: string[] = [];
    const normalized = this.parseAutomationSource(source);
    if (!/\bexport\s+class\s+AutomationWorkflow\s+extends\s+WorkflowEntrypoint\b/.test(normalized)) {
      errors.push(
        "source must export `class AutomationWorkflow extends WorkflowEntrypoint`",
      );
    }

    const loader = this.env.CODE_MODE_LOADER as
      | (WorkerLoader & { load?: (code: WorkerLoaderWorkerCode) => WorkerStub })
      | undefined;
    if (loader) {
      try {
        const workerCode: WorkerLoaderWorkerCode = {
          compatibilityDate: "2026-05-18",
          mainModule: "index.js",
          modules: {
            "index.js": { js: normalized },
          },
          env: {},
        };
        const worker =
          typeof loader.load === "function"
            ? loader.load(workerCode)
            : loader.get(`automation-validate-${crypto.randomUUID()}`, () => workerCode);
        worker.getEntrypoint("AutomationWorkflow");
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return { valid: errors.length === 0, errors };
  }

  private async assertValidDeterministicAutomationSource(
    source: string,
  ): Promise<void> {
    const result = await this.validateDeterministicAutomationSource(source);
    if (!result.valid) {
      throw new Error(`Invalid deterministic automation source: ${result.errors.join("; ")}`);
    }
  }

  private async dispatchDeterministicAutomation(
    automation: WorkspaceDeterministicAutomation,
    workspace: WorkspaceInfo,
    scheduledForMs: number,
    trigger: "schedule" | "manual",
  ): Promise<DeterministicAutomationDispatchResult> {
    if (!this.env.DETERMINISTIC_AUTOMATION_WORKFLOWS) {
      return {
        status: "error",
        error: "Deterministic automation workflow binding is not configured",
      };
    }

    try {
      const workflow = wrapWorkflowBinding(
        {
          workspaceId: workspace.id,
          automationId: automation.id,
          sourceVersion: automation.source_version,
        },
        { bindingName: AUTOMATION_WORKFLOW_BINDING },
      ) as Workflow;
      const instance = await workflow.create({
        params: {
          workspaceId: workspace.id,
          automationId: automation.id,
          automationName: automation.name,
          scheduledFor: new Date(scheduledForMs).toISOString(),
          triggeredAt: new Date().toISOString(),
          trigger,
        },
      });
      return {
        status: "started",
        instanceId: await instance.id,
      };
    } catch (error) {
      return {
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT MIN(next_run_at) AS next_run_at
         FROM (
           SELECT next_run_at
           FROM scheduled_prompts
           WHERE enabled = 1 AND next_run_at IS NOT NULL
           UNION ALL
           SELECT next_run_at
           FROM deterministic_automations
           WHERE enabled = 1 AND next_run_at IS NOT NULL
         )`,
      )
      .toArray() as Array<{ next_run_at: number | null }>;

    const nextRunAt = rows[0]?.next_run_at ?? null;
    if (!nextRunAt) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const now = Date.now();
    await this.ctx.storage.setAlarm(Math.max(now + 1000, nextRunAt));
  }

  async listScheduledPrompts(
    workspaceId: string,
  ): Promise<WorkspaceScheduledPrompt[]> {
    this.assertWorkspaceIdentity(workspaceId);
    const rows = this.sql
      .exec("SELECT * FROM scheduled_prompts ORDER BY created_at DESC")
      .toArray() as unknown as ScheduledPromptRow[];
    return rows.map((row) => this.toPrompt(row));
  }

  async listDeterministicAutomations(
    workspaceId: string,
  ): Promise<WorkspaceDeterministicAutomation[]> {
    this.assertWorkspaceIdentity(workspaceId);
    const rows = this.sql
      .exec("SELECT * FROM deterministic_automations ORDER BY created_at DESC")
      .toArray() as unknown as DeterministicAutomationRow[];
    return rows.map((row) => this.toAutomation(row));
  }

  async getDeterministicAutomationSource(
    workspaceId: string,
    automationId: string,
    sourceVersion?: number | null,
  ): Promise<DeterministicAutomationSourceSnapshot | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const trimmedId = automationId.trim();
    if (!trimmedId) {
      throw new Error("automationId is required");
    }

    if (typeof sourceVersion === "number" && Number.isFinite(sourceVersion)) {
      const rows = this.sql
        .exec(
          `SELECT automation_id, workspace_id, source_version, source, created_by, created_at
           FROM deterministic_automation_versions
           WHERE automation_id = ? AND source_version = ? AND workspace_id = ?`,
          trimmedId,
          Math.floor(sourceVersion),
          workspaceId,
        )
        .toArray() as unknown as DeterministicAutomationVersionRow[];
      const row = rows[0];
      if (!row) return null;
      return {
        automation_id: row.automation_id,
        workspace_id: row.workspace_id,
        source_version: row.source_version,
        source: row.source,
        created_by: row.created_by,
      };
    }

    const row = this.getAutomationRow(trimmedId);
    if (!row) return null;
    return {
      automation_id: row.id,
      workspace_id: workspaceId,
      source_version: row.source_version,
      source: row.source,
      created_by: row.created_by,
    };
  }

  async createScheduledPrompt(
    input: CreateScheduledPromptInput,
  ): Promise<WorkspaceScheduledPrompt> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const name = this.parseName(input.name);
    const prompt = this.parsePrompt(input.prompt);
    const cronExpression = this.normalizeCronExpression(input.cronExpression);
    const createdBy = input.createdBy?.trim() || "system";
    const scheduledByThreadId = this.parseOptionalThreadId(
      input.scheduledByThreadId,
    );
    const enabled = input.enabled ?? true;
    await this.assertCronWithinBillingLimits(
      workspace,
      cronExpression,
      createdBy,
    );

    const now = Date.now();
    const nextRunAt = enabled ? getNextCronRunAt(cronExpression, now) : null;
    if (enabled && !nextRunAt) {
      throw new Error(
        "Unable to compute next run time for this cron expression",
      );
    }
    const threadId = await this.createInitialThreadForPrompt(
      workspace,
      name,
      prompt,
      createdBy,
    );

    const id = crypto.randomUUID();
    this.sql.exec(
      `INSERT INTO scheduled_prompts
       (id, name, prompt, cron_expression, thread_id, scheduled_by_thread_id, enabled, created_by, created_at, updated_at, next_run_at, last_run_at, last_run_status, last_run_error, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, 0)`,
      id,
      name,
      prompt,
      cronExpression,
      threadId,
      scheduledByThreadId,
      enabled ? 1 : 0,
      createdBy,
      now,
      now,
      nextRunAt,
    );

    await this.scheduleNextAlarm();
    const created = this.getPromptRow(id);
    if (!created) {
      throw new Error("Failed to create scheduled prompt");
    }
    return this.toPrompt(created);
  }

  async createDeterministicAutomation(
    input: CreateDeterministicAutomationInput,
  ): Promise<WorkspaceDeterministicAutomation> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const name = this.parseName(input.name);
    const description = this.parseDescription(input.description);
    const source = this.parseAutomationSource(input.source);
    await this.assertValidDeterministicAutomationSource(source);
    const cronExpression = this.normalizeCronExpression(input.cronExpression);
    const createdBy = input.createdBy?.trim() || "system";
    const enabled = input.enabled ?? true;
    await this.assertCronWithinBillingLimits(
      workspace,
      cronExpression,
      createdBy,
    );

    const now = Date.now();
    const nextRunAt = enabled ? getNextCronRunAt(cronExpression, now) : null;
    if (enabled && !nextRunAt) {
      throw new Error(
        "Unable to compute next run time for this cron expression",
      );
    }

    const id = crypto.randomUUID();
    const sourceVersion = 1;
    this.sql.exec(
      `INSERT INTO deterministic_automations
       (id, name, description, source, source_version, cron_expression, enabled, created_by, created_at, updated_at, next_run_at, last_run_at, last_run_status, last_run_error, last_instance_id, run_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
      id,
      name,
      description,
      source,
      sourceVersion,
      cronExpression,
      enabled ? 1 : 0,
      createdBy,
      now,
      now,
      nextRunAt,
    );
    this.insertAutomationVersion(
      workspaceId,
      id,
      sourceVersion,
      source,
      createdBy,
      now,
    );

    await this.scheduleNextAlarm();
    const created = this.getAutomationRow(id);
    if (!created) {
      throw new Error("Failed to create deterministic automation");
    }
    return this.toAutomation(created);
  }

  async updateScheduledPrompt(
    input: UpdateScheduledPromptInput,
  ): Promise<WorkspaceScheduledPrompt | null> {
    this.assertWorkspaceIdentity(input.workspaceId);
    const existing = this.getPromptRow(input.id);
    if (!existing) return null;

    const workspace = await this.getWorkspaceInfo(input.workspaceId);
    const existingPrompt = this.toPrompt(existing);
    const name =
      input.name !== undefined
        ? this.parseName(input.name)
        : existingPrompt.name;
    const prompt =
      input.prompt !== undefined
        ? this.parsePrompt(input.prompt)
        : existingPrompt.prompt;
    const cronExpression =
      input.cronExpression !== undefined
        ? this.normalizeCronExpression(input.cronExpression)
        : existingPrompt.cron_expression;
    const enabled =
      input.enabled !== undefined ? input.enabled : existingPrompt.enabled;
    await this.assertCronWithinBillingLimits(
      workspace,
      cronExpression,
      existingPrompt.created_by,
      existingPrompt.id,
    );

    const now = Date.now();
    let nextRunAt: number | null;
    if (!enabled) {
      nextRunAt = null;
    } else {
      const cronChanged = cronExpression !== existingPrompt.cron_expression;
      const needsRecompute =
        !existingPrompt.enabled ||
        cronChanged ||
        existingPrompt.next_run_at === null;
      nextRunAt = needsRecompute
        ? getNextCronRunAt(cronExpression, now)
        : existingPrompt.next_run_at;
      if (!nextRunAt) {
        throw new Error(
          "Unable to compute next run time for this cron expression",
        );
      }
    }

    this.sql.exec(
      `UPDATE scheduled_prompts
       SET name = ?, prompt = ?, cron_expression = ?, enabled = ?, updated_at = ?, next_run_at = ?
       WHERE id = ?`,
      name,
      prompt,
      cronExpression,
      enabled ? 1 : 0,
      now,
      nextRunAt,
      existingPrompt.id,
    );

    await this.scheduleNextAlarm();
    const updated = this.getPromptRow(existingPrompt.id);
    return updated ? this.toPrompt(updated) : null;
  }

  async updateDeterministicAutomation(
    input: UpdateDeterministicAutomationInput,
  ): Promise<WorkspaceDeterministicAutomation | null> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const existing = this.getAutomationRow(input.id);
    if (!existing) return null;

    const workspace = await this.getWorkspaceInfo(workspaceId);
    const existingAutomation = this.toAutomation(existing);
    const name =
      input.name !== undefined
        ? this.parseName(input.name)
        : existingAutomation.name;
    const description =
      input.description !== undefined
        ? this.parseDescription(input.description)
        : existingAutomation.description;
    const source =
      input.source !== undefined
        ? this.parseAutomationSource(input.source)
        : existingAutomation.source;
    if (input.source !== undefined && source !== existingAutomation.source) {
      await this.assertValidDeterministicAutomationSource(source);
    }
    const cronExpression =
      input.cronExpression !== undefined
        ? this.normalizeCronExpression(input.cronExpression)
        : existingAutomation.cron_expression;
    const enabled =
      input.enabled !== undefined ? input.enabled : existingAutomation.enabled;
    await this.assertCronWithinBillingLimits(
      workspace,
      cronExpression,
      existingAutomation.created_by,
      existingAutomation.id,
    );

    const now = Date.now();
    const sourceChanged = source !== existingAutomation.source;
    const sourceVersion = sourceChanged
      ? existingAutomation.source_version + 1
      : existingAutomation.source_version;
    let nextRunAt: number | null;
    if (!enabled) {
      nextRunAt = null;
    } else {
      const cronChanged =
        cronExpression !== existingAutomation.cron_expression;
      const needsRecompute =
        !existingAutomation.enabled ||
        cronChanged ||
        existingAutomation.next_run_at === null;
      nextRunAt = needsRecompute
        ? getNextCronRunAt(cronExpression, now)
        : existingAutomation.next_run_at;
      if (!nextRunAt) {
        throw new Error(
          "Unable to compute next run time for this cron expression",
        );
      }
    }

    this.sql.exec(
      `UPDATE deterministic_automations
       SET name = ?, description = ?, source = ?, source_version = ?, cron_expression = ?, enabled = ?, updated_at = ?, next_run_at = ?
       WHERE id = ?`,
      name,
      description,
      source,
      sourceVersion,
      cronExpression,
      enabled ? 1 : 0,
      now,
      nextRunAt,
      existingAutomation.id,
    );
    if (sourceChanged) {
      this.insertAutomationVersion(
        workspaceId,
        existingAutomation.id,
        sourceVersion,
        source,
        existingAutomation.created_by,
        now,
      );
    }

    await this.scheduleNextAlarm();
    const updated = this.getAutomationRow(existingAutomation.id);
    return updated ? this.toAutomation(updated) : null;
  }

  async deleteScheduledPrompt(
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    this.assertWorkspaceIdentity(workspaceId);
    const existing = this.getPromptRow(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM scheduled_prompts WHERE id = ?", id);
    await this.scheduleNextAlarm();
    return true;
  }

  async deleteDeterministicAutomation(
    workspaceId: string,
    id: string,
  ): Promise<boolean> {
    this.assertWorkspaceIdentity(workspaceId);
    const existing = this.getAutomationRow(id);
    if (!existing) return false;
    this.sql.exec("DELETE FROM deterministic_automations WHERE id = ?", id);
    await this.scheduleNextAlarm();
    return true;
  }

  async disableAllScheduledPrompts(
    workspaceId: string,
    reason = "disabled",
  ): Promise<void> {
    this.assertWorkspaceIdentity(workspaceId);
    const now = Date.now();
    this.sql.exec(
      `UPDATE scheduled_prompts
       SET enabled = 0, next_run_at = NULL, updated_at = ?, last_run_error = ?
       WHERE enabled = 1`,
      now,
      reason,
    );
    this.sql.exec(
      `UPDATE deterministic_automations
       SET enabled = 0, next_run_at = NULL, updated_at = ?, last_run_error = ?
       WHERE enabled = 1`,
      now,
      reason,
    );
    await this.ctx.storage.deleteAlarm();
  }

  async runScheduledPromptNow(
    workspaceId: string,
    id: string,
  ): Promise<RunScheduledPromptNowResult | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const existingRow = this.getPromptRow(id);
    if (!existingRow) return null;
    const existing = this.toPrompt(existingRow);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const runStartedAt = Date.now();
    const dispatch = await this.dispatchPrompt(
      existing,
      workspace,
      runStartedAt,
    );

    let nextRunAt = existing.next_run_at;
    if (existing.enabled && (!nextRunAt || nextRunAt <= runStartedAt)) {
      nextRunAt = getNextCronRunAt(existing.cron_expression, runStartedAt);
    }

    this.sql.exec(
      `UPDATE scheduled_prompts
       SET thread_id = ?, updated_at = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, run_count = run_count + 1
       WHERE id = ?`,
      dispatch.threadId,
      Date.now(),
      existing.enabled ? nextRunAt : null,
      runStartedAt,
      dispatch.status,
      dispatch.error ?? null,
      existing.id,
    );

    await this.scheduleNextAlarm();
    const updated = this.getPromptRow(existing.id);
    if (!updated) return null;
    return {
      prompt: this.toPrompt(updated),
      dispatch: {
        status: dispatch.status,
        thread_id: dispatch.threadId,
        error: dispatch.error,
      },
    };
  }

  async runDeterministicAutomationNow(
    workspaceId: string,
    id: string,
  ): Promise<RunDeterministicAutomationNowResult | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const existingRow = this.getAutomationRow(id);
    if (!existingRow) return null;
    const existing = this.toAutomation(existingRow);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const runStartedAt = Date.now();
    const dispatch = await this.dispatchDeterministicAutomation(
      existing,
      workspace,
      runStartedAt,
      "manual",
    );

    let nextRunAt = existing.next_run_at;
    if (existing.enabled && (!nextRunAt || nextRunAt <= runStartedAt)) {
      nextRunAt = getNextCronRunAt(existing.cron_expression, runStartedAt);
    }

    this.sql.exec(
      `UPDATE deterministic_automations
       SET updated_at = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = ?, run_count = run_count + 1
       WHERE id = ?`,
      Date.now(),
      existing.enabled ? nextRunAt : null,
      runStartedAt,
      dispatch.status,
      dispatch.error ?? null,
      dispatch.instanceId ?? null,
      existing.id,
    );

    await this.scheduleNextAlarm();
    const updated = this.getAutomationRow(existing.id);
    if (!updated) return null;
    return {
      automation: this.toAutomation(updated),
      dispatch: {
        status: dispatch.status,
        instance_id: dispatch.instanceId,
        error: dispatch.error,
      },
    };
  }

  async alarm(): Promise<void> {
    const workspaceId = this.getStoredWorkspaceId();
    if (!workspaceId) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    let workspace: WorkspaceInfo;
    try {
      workspace = await this.getWorkspaceInfo(workspaceId);
    } catch (error) {
      console.warn(
        "[WorkspaceCronDO] workspace unavailable, disabling scheduled prompts",
        {
          workspaceId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await this.disableAllScheduledPrompts(
        workspaceId,
        "workspace_unavailable",
      );
      return;
    }

    const now = Date.now();
    const dueRows = this.sql
      .exec(
        `SELECT * FROM scheduled_prompts
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
        now,
        MAX_DUE_JOBS_PER_ALARM,
      )
      .toArray() as unknown as ScheduledPromptRow[];

    for (const row of dueRows) {
      const prompt = this.toPrompt(row);
      const runStartedAt = Date.now();
      const scheduledFor = prompt.next_run_at ?? runStartedAt;
      const dispatch = await this.dispatchPrompt(
        prompt,
        workspace,
        scheduledFor,
      );
      const nextRunAt = getNextCronRunAt(prompt.cron_expression, runStartedAt);
      const enabledAfterRun = Boolean(nextRunAt);

      this.sql.exec(
        `UPDATE scheduled_prompts
         SET thread_id = ?, updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, run_count = run_count + 1
         WHERE id = ?`,
        dispatch.threadId,
        Date.now(),
        enabledAfterRun ? 1 : 0,
        nextRunAt,
        runStartedAt,
        dispatch.status,
        dispatch.error ?? (!enabledAfterRun ? "No future run found" : null),
        prompt.id,
      );
    }

    const dueAutomationRows = this.sql
      .exec(
        `SELECT * FROM deterministic_automations
         WHERE enabled = 1
           AND next_run_at IS NOT NULL
           AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
        now,
        MAX_DUE_JOBS_PER_ALARM,
      )
      .toArray() as unknown as DeterministicAutomationRow[];

    for (const row of dueAutomationRows) {
      const automation = this.toAutomation(row);
      const runStartedAt = Date.now();
      const scheduledFor = automation.next_run_at ?? runStartedAt;
      const dispatch = await this.dispatchDeterministicAutomation(
        automation,
        workspace,
        scheduledFor,
        "schedule",
      );
      const nextRunAt = getNextCronRunAt(
        automation.cron_expression,
        runStartedAt,
      );
      const enabledAfterRun = Boolean(nextRunAt);

      this.sql.exec(
        `UPDATE deterministic_automations
         SET updated_at = ?, enabled = ?, next_run_at = ?, last_run_at = ?, last_run_status = ?, last_run_error = ?, last_instance_id = ?, run_count = run_count + 1
         WHERE id = ?`,
        Date.now(),
        enabledAfterRun ? 1 : 0,
        nextRunAt,
        runStartedAt,
        dispatch.status,
        dispatch.error ?? (!enabledAfterRun ? "No future run found" : null),
        dispatch.instanceId ?? null,
        automation.id,
      );
    }

    await this.scheduleNextAlarm();
  }
}
