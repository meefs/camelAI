import type { WorkspaceCronDO } from "./workspace-cron";

interface CodeModeScheduledPromptsOptions {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  threadId?: string;
  userId?: string;
}

interface ScheduledPromptRecord {
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
  last_run_status: string | null;
  last_run_error: string | null;
  run_count: number;
}

function formatScheduledPrompt(prompt: ScheduledPromptRecord): Record<string, unknown> {
  return {
    id: prompt.id,
    name: prompt.name,
    prompt: prompt.prompt,
    cron_expression: prompt.cron_expression,
    thread_id: prompt.thread_id,
    scheduled_by_thread_id: prompt.scheduled_by_thread_id,
    enabled: prompt.enabled,
    created_by: prompt.created_by,
    created_at: new Date(prompt.created_at).toISOString(),
    updated_at: new Date(prompt.updated_at).toISOString(),
    next_run_at: prompt.next_run_at ? new Date(prompt.next_run_at).toISOString() : null,
    last_run_at: prompt.last_run_at ? new Date(prompt.last_run_at).toISOString() : null,
    last_run_status: prompt.last_run_status,
    last_run_error: prompt.last_run_error,
    run_count: prompt.run_count,
  };
}

export class CodeModeScheduledPrompts {
  constructor(private readonly options: CodeModeScheduledPromptsOptions) {}

  async list(): Promise<unknown> {
    const prompts = await this.options.cronStub.listScheduledPrompts(this.options.workspaceId);
    return {
      success: true,
      count: prompts.length,
      timezone: "UTC",
      prompts: prompts.map((prompt) => formatScheduledPrompt(prompt)),
    };
  }

  async create(args: Record<string, unknown>): Promise<unknown> {
    const name = typeof args.name === "string" ? args.name : "";
    const prompt = typeof args.prompt === "string" ? args.prompt : "";
    const cronExpression =
      typeof args.cron_expression === "string" ? args.cron_expression : "";
    if (!name.trim()) throw new Error("name is required");
    if (!prompt.trim()) throw new Error("prompt is required");
    if (!cronExpression.trim()) throw new Error("cron_expression is required");
    const created = await this.options.cronStub.createScheduledPrompt({
      workspaceId: this.options.workspaceId,
      name,
      prompt,
      cronExpression,
      createdBy: this.options.userId || "system",
      scheduledByThreadId: this.options.threadId,
      enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    });
    return {
      success: true,
      timezone: "UTC",
      scheduled_prompt: formatScheduledPrompt(created),
      message: `Created scheduled prompt "${created.name}"`,
    };
  }

  async update(args: Record<string, unknown>): Promise<unknown> {
    const promptId = typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
    if (!promptId) throw new Error("prompt_id is required");
    const updated = await this.options.cronStub.updateScheduledPrompt({
      workspaceId: this.options.workspaceId,
      id: promptId,
      name: typeof args.name === "string" ? args.name : undefined,
      prompt: typeof args.prompt === "string" ? args.prompt : undefined,
      cronExpression: typeof args.cron_expression === "string" ? args.cron_expression : undefined,
      enabled: typeof args.enabled === "boolean" ? args.enabled : undefined,
    });
    if (!updated) return { success: false, error: `Scheduled prompt "${promptId}" not found` };
    return {
      success: true,
      timezone: "UTC",
      scheduled_prompt: formatScheduledPrompt(updated),
      message: `Updated scheduled prompt "${updated.name}"`,
    };
  }

  async delete(args: Record<string, unknown>): Promise<unknown> {
    const promptId = typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
    if (!promptId) throw new Error("prompt_id is required");
    const deleted = await this.options.cronStub.deleteScheduledPrompt(this.options.workspaceId, promptId);
    if (!deleted) return { success: false, error: `Scheduled prompt "${promptId}" not found` };
    return { success: true, message: `Deleted scheduled prompt "${promptId}"` };
  }

  async runNow(args: Record<string, unknown>): Promise<unknown> {
    const promptId = typeof args.prompt_id === "string" ? args.prompt_id.trim() : "";
    if (!promptId) throw new Error("prompt_id is required");
    const result = await this.options.cronStub.runScheduledPromptNow(this.options.workspaceId, promptId);
    if (!result) return { success: false, error: `Scheduled prompt "${promptId}" not found` };
    return {
      success: true,
      timezone: "UTC",
      scheduled_prompt: formatScheduledPrompt(result.prompt),
      run: {
        status: result.dispatch.status,
        thread_id: result.dispatch.thread_id,
        error: result.dispatch.error,
        reply: result.dispatch.reply,
      },
    };
  }
}
