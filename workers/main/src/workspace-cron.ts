import { DurableObject } from 'cloudflare:workers';
import type { OrgDO, OrgThread } from './auth';
import type { ChatThreadDO, ExternalMessageRequest, ExternalTurnResult } from './durable-objects';
import { getNextCronRunAt, parseCronExpression } from './cron-schedule';
import type { WorkspaceDO } from './workspace';
import {
  getDefaultLlmModel,
  getDefaultThreadProvider,
} from '../../../src/lib/llm-provider-config';

const DEFAULT_EXTERNAL_MESSAGE_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_DUE_JOBS_PER_ALARM = 20;
const WORKSPACE_ID_KEY = 'workspaceId';

type RunStatus = 'success' | 'busy' | 'question' | 'error';

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

interface WorkspaceInfo {
  id: string;
  org_id: string;
  archived: boolean;
}

interface DispatchResult {
  status: RunStatus;
  error?: string;
  reply?: string;
  threadId: string;
}

type ExternalMessageRpc = {
  externalMessage: (body: ExternalMessageRequest) => Promise<ExternalTurnResult>;
};

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

export interface CreateScheduledPromptInput {
  workspaceId: string;
  name: string;
  prompt: string;
  cronExpression: string;
  createdBy: string;
  scheduledByThreadId?: string | null;
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

export interface RunScheduledPromptNowResult {
  prompt: WorkspaceScheduledPrompt;
  dispatch: {
    status: RunStatus;
    thread_id: string;
    error?: string;
    reply?: string;
  };
}

export interface WorkspaceCronEnv {
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
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
    const version = this.ctx.storage.kv.get<number>('schemaVersion') ?? 0;
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
        'CREATE INDEX IF NOT EXISTS idx_scheduled_prompts_next_run ON scheduled_prompts(enabled, next_run_at)'
      );
    }

    if (version >= 1 && version < 2) {
      this.sql.exec('ALTER TABLE scheduled_prompts ADD COLUMN scheduled_by_thread_id TEXT');
    }

    if (version < 2) {
      this.ctx.storage.kv.put('schemaVersion', 2);
    }
  }

  private normalizeWorkspaceId(workspaceId: string): string {
    const normalized = workspaceId.trim();
    if (!normalized) {
      throw new Error('workspaceId is required');
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
      throw new Error('Workspace scheduler context mismatch');
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

  private parseName(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error('name is required');
    }
    if (trimmed.length > 120) {
      throw new Error('name must be 120 characters or fewer');
    }
    return trimmed;
  }

  private parsePrompt(value: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new Error('prompt is required');
    }
    if (trimmed.length > 20_000) {
      throw new Error('prompt must be 20000 characters or fewer');
    }
    return trimmed;
  }

  private parseOptionalThreadId(value: string | null | undefined): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }

  private normalizeCronExpression(value: string): string {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    if (!trimmed) {
      throw new Error('cronExpression is required');
    }
    if (trimmed.length > 100) {
      throw new Error('cronExpression must be 100 characters or fewer');
    }
    parseCronExpression(trimmed);
    return trimmed;
  }

  private getPromptRow(id: string): ScheduledPromptRow | null {
    const rows = this.sql
      .exec('SELECT * FROM scheduled_prompts WHERE id = ?', id)
      .toArray() as unknown as ScheduledPromptRow[];
    return rows[0] ?? null;
  }

  private async getWorkspaceInfo(workspaceId: string): Promise<WorkspaceInfo> {
    const workspaceStub = this.env.WORKSPACE.get(
      this.env.WORKSPACE.idFromName(workspaceId)
    ) as DurableObjectStub<WorkspaceDO>;
    const info = await workspaceStub.getInfo();
    if (!info || info.archived) {
      throw new Error('Workspace not found or archived');
    }
    return {
      id: info.id,
      org_id: info.org_id,
      archived: info.archived,
    };
  }

  private getOrgStub(orgId: string): DurableObjectStub<OrgDO> {
    return this.env.ORG.get(this.env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
  }

  private async createInitialThreadForPrompt(
    workspace: WorkspaceInfo,
    name: string,
    prompt: string,
    createdBy: string
  ): Promise<string> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const [llmProviderConfig, experimentalSettings] = await Promise.all([
      orgStub.getLlmProviderConfig(),
      orgStub.getExperimentalSettings(),
    ]);
    const provider = getDefaultThreadProvider(llmProviderConfig?.provider, experimentalSettings);
    const created = await orgStub.createThread(
      workspace.id,
      `Scheduled: ${name}`,
      createdBy || 'system',
      prompt.slice(0, 500),
      getDefaultLlmModel(provider),
      provider
    ) as OrgThread;
    return created.id;
  }

  private async ensureRunnableThread(
    prompt: WorkspaceScheduledPrompt,
    workspace: WorkspaceInfo
  ): Promise<string> {
    const orgStub = this.getOrgStub(workspace.org_id);
    const existing = await orgStub.getThread(prompt.thread_id) as OrgThread | null;
    if (existing && existing.workspace_id === workspace.id) {
      return prompt.thread_id;
    }

    const [llmProviderConfig, experimentalSettings] = await Promise.all([
      orgStub.getLlmProviderConfig(),
      orgStub.getExperimentalSettings(),
    ]);
    const provider = getDefaultThreadProvider(llmProviderConfig?.provider, experimentalSettings);
    const created = await orgStub.createThread(
      workspace.id,
      `Scheduled: ${prompt.name}`,
      'system',
      prompt.prompt.slice(0, 500),
      getDefaultLlmModel(provider),
      provider
    ) as OrgThread;

    this.sql.exec(
      'UPDATE scheduled_prompts SET thread_id = ?, updated_at = ? WHERE id = ?',
      created.id,
      Date.now(),
      prompt.id
    );
    return created.id;
  }

  private buildScheduledMessage(prompt: WorkspaceScheduledPrompt, scheduledForMs: number): string {
    const scheduledForIso = new Date(scheduledForMs).toISOString();
    const originThreadId = prompt.scheduled_by_thread_id ?? 'unknown';
    return [
      `<camelai system message>Scheduled prompt "${prompt.name}" fired at ${scheduledForIso} UTC. Origin scheduler thread/session id: ${originThreadId}. Use this id to search prior context from when this cron was created.</camelai system message>`,
      prompt.prompt,
    ].join('\n\n');
  }

  private async dispatchPrompt(
    prompt: WorkspaceScheduledPrompt,
    workspace: WorkspaceInfo,
    scheduledForMs: number
  ): Promise<DispatchResult> {
    const threadId = await this.ensureRunnableThread(prompt, workspace);
    const chatThreadStub = this.env.CHAT_THREAD.get(
      this.env.CHAT_THREAD.idFromName(threadId)
    ) as DurableObjectStub<ExternalMessageRpc>;

    try {
      const payload = await chatThreadStub.externalMessage({
        threadId,
        workspaceId: workspace.id,
        orgId: workspace.org_id,
        userName: 'Scheduler',
        message: this.buildScheduledMessage(prompt, scheduledForMs),
        timeoutMs: DEFAULT_EXTERNAL_MESSAGE_TIMEOUT_MS,
      });
      switch (payload.status) {
        case 'result':
          return {
            status: 'success',
            reply: typeof payload.reply === 'string' ? payload.reply : undefined,
            threadId,
          };
        case 'busy':
          return {
            status: 'busy',
            error: 'Thread is busy with another run',
            threadId,
          };
        case 'error':
          return {
            status: 'error',
            error: typeof payload.error === 'string' ? payload.error : 'Unknown chat error',
            threadId,
          };
        default:
          return {
            status: 'error',
            error: 'Unexpected response from chat thread',
            threadId,
          };
      }
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        threadId,
      };
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const rows = this.sql
      .exec(
        `SELECT MIN(next_run_at) as next_run_at
         FROM scheduled_prompts
         WHERE enabled = 1 AND next_run_at IS NOT NULL`
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

  async listScheduledPrompts(workspaceId: string): Promise<WorkspaceScheduledPrompt[]> {
    this.assertWorkspaceIdentity(workspaceId);
    const rows = this.sql
      .exec('SELECT * FROM scheduled_prompts ORDER BY created_at DESC')
      .toArray() as unknown as ScheduledPromptRow[];
    return rows.map((row) => this.toPrompt(row));
  }

  async createScheduledPrompt(input: CreateScheduledPromptInput): Promise<WorkspaceScheduledPrompt> {
    const workspaceId = this.assertWorkspaceIdentity(input.workspaceId);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const name = this.parseName(input.name);
    const prompt = this.parsePrompt(input.prompt);
    const cronExpression = this.normalizeCronExpression(input.cronExpression);
    const createdBy = input.createdBy?.trim() || 'system';
    const scheduledByThreadId = this.parseOptionalThreadId(input.scheduledByThreadId);
    const enabled = input.enabled ?? true;

    const now = Date.now();
    const nextRunAt = enabled ? getNextCronRunAt(cronExpression, now) : null;
    if (enabled && !nextRunAt) {
      throw new Error('Unable to compute next run time for this cron expression');
    }
    const threadId = await this.createInitialThreadForPrompt(workspace, name, prompt, createdBy);

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
      nextRunAt
    );

    await this.scheduleNextAlarm();
    const created = this.getPromptRow(id);
    if (!created) {
      throw new Error('Failed to create scheduled prompt');
    }
    return this.toPrompt(created);
  }

  async updateScheduledPrompt(input: UpdateScheduledPromptInput): Promise<WorkspaceScheduledPrompt | null> {
    this.assertWorkspaceIdentity(input.workspaceId);
    const existing = this.getPromptRow(input.id);
    if (!existing) return null;

    await this.getWorkspaceInfo(input.workspaceId);
    const existingPrompt = this.toPrompt(existing);
    const name = input.name !== undefined ? this.parseName(input.name) : existingPrompt.name;
    const prompt = input.prompt !== undefined ? this.parsePrompt(input.prompt) : existingPrompt.prompt;
    const cronExpression = input.cronExpression !== undefined
      ? this.normalizeCronExpression(input.cronExpression)
      : existingPrompt.cron_expression;
    const enabled = input.enabled !== undefined ? input.enabled : existingPrompt.enabled;

    const now = Date.now();
    let nextRunAt: number | null;
    if (!enabled) {
      nextRunAt = null;
    } else {
      const cronChanged = cronExpression !== existingPrompt.cron_expression;
      const needsRecompute = !existingPrompt.enabled || cronChanged || existingPrompt.next_run_at === null;
      nextRunAt = needsRecompute ? getNextCronRunAt(cronExpression, now) : existingPrompt.next_run_at;
      if (!nextRunAt) {
        throw new Error('Unable to compute next run time for this cron expression');
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
      existingPrompt.id
    );

    await this.scheduleNextAlarm();
    const updated = this.getPromptRow(existingPrompt.id);
    return updated ? this.toPrompt(updated) : null;
  }

  async deleteScheduledPrompt(workspaceId: string, id: string): Promise<boolean> {
    this.assertWorkspaceIdentity(workspaceId);
    const existing = this.getPromptRow(id);
    if (!existing) return false;
    this.sql.exec('DELETE FROM scheduled_prompts WHERE id = ?', id);
    await this.scheduleNextAlarm();
    return true;
  }

  async disableAllScheduledPrompts(workspaceId: string, reason = 'disabled'): Promise<void> {
    this.assertWorkspaceIdentity(workspaceId);
    const now = Date.now();
    this.sql.exec(
      `UPDATE scheduled_prompts
       SET enabled = 0, next_run_at = NULL, updated_at = ?, last_run_error = ?
       WHERE enabled = 1`,
      now,
      reason
    );
    await this.ctx.storage.deleteAlarm();
  }

  async runScheduledPromptNow(workspaceId: string, id: string): Promise<RunScheduledPromptNowResult | null> {
    this.assertWorkspaceIdentity(workspaceId);
    const existingRow = this.getPromptRow(id);
    if (!existingRow) return null;
    const existing = this.toPrompt(existingRow);
    const workspace = await this.getWorkspaceInfo(workspaceId);
    const runStartedAt = Date.now();
    const dispatch = await this.dispatchPrompt(existing, workspace, runStartedAt);

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
      existing.id
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
        reply: dispatch.reply,
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
      console.warn('[WorkspaceCronDO] workspace unavailable, disabling scheduled prompts', {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      await this.disableAllScheduledPrompts(workspaceId, 'workspace_unavailable');
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
        MAX_DUE_JOBS_PER_ALARM
      )
      .toArray() as unknown as ScheduledPromptRow[];

    for (const row of dueRows) {
      const prompt = this.toPrompt(row);
      const runStartedAt = Date.now();
      const scheduledFor = prompt.next_run_at ?? runStartedAt;
      const dispatch = await this.dispatchPrompt(prompt, workspace, scheduledFor);
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
        dispatch.error ?? (!enabledAfterRun ? 'No future run found' : null),
        prompt.id
      );
    }

    await this.scheduleNextAlarm();
  }
}
