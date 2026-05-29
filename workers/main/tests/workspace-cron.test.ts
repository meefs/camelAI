import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { OrgDO } from '../src/auth';
import { CodeModeDeterministicAutomations } from '../src/code-mode-deterministic-automations';
import type { AutomationRunCursor, WorkspaceCronDO } from '../src/workspace-cron';
import { createOrg, createUser, listUserWorkspaces, type TestEnv } from './test-helpers';

interface TestEnvWithCron extends TestEnv {
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
}

describe('WorkspaceCronDO', () => {
  const testEnv = env as unknown as TestEnvWithCron;
  const testEmail = () => `cron-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const automationSource = (label = 'ok') => `import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    return await step.do("${label}", async () => ({ payload: event.payload }));
  }
}
`;

  it('creates, lists, updates, and deletes scheduled prompts', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Cron Owner');
    const { org } = await createOrg(testEnv, 'Cron Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id)) as DurableObjectStub<OrgDO>;

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Daily digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
      scheduledByThreadId: 'thread-origin-123',
    });

    expect(created.id).toBeTypeOf('string');
    expect(created.thread_id).toBeTypeOf('string');
    expect(created.scheduled_by_thread_id).toBe('thread-origin-123');
    expect(created.enabled).toBe(true);
    expect(created.next_run_at).toBeTypeOf('number');
    const createdThread = await orgStub.getThread(created.thread_id);
    expect(createdThread?.workspace_id).toBe(workspaceId);

    const listAfterCreate = await cronStub.listScheduledPrompts(workspaceId!);
    expect(listAfterCreate).toHaveLength(1);
    expect(listAfterCreate[0]?.name).toBe('Daily digest');

    const updated = await cronStub.updateScheduledPrompt({
      workspaceId: workspaceId!,
      id: created.id,
      name: 'Daily summary',
      enabled: false,
    });
    expect(updated?.name).toBe('Daily summary');
    expect(updated?.enabled).toBe(false);
    expect(updated?.next_run_at).toBeNull();

    const run = await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    expect(run?.prompt.id).toBe(created.id);
    const runsAfterStart = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const scheduledRuns = runsAfterStart[`scheduled_prompt:${created.id}`] ?? [];
    expect(scheduledRuns).toHaveLength(1);
    expect(scheduledRuns[0]?.kind).toBe('scheduled_prompt');
    expect(scheduledRuns[0]?.trigger).toBe('manual');
    expect(scheduledRuns[0]?.thread_id).toBe(run?.dispatch.thread_id);

    const questionRecorded = await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: scheduledRuns[0]!.id,
      status: 'question',
      message: 'Should I continue?',
    });
    expect(questionRecorded).toBe(true);
    const promptsAfterQuestion = await cronStub.listScheduledPrompts(workspaceId!);
    expect(promptsAfterQuestion[0]?.last_run_status).toBe('question');
    expect(promptsAfterQuestion[0]?.last_run_error).toBeNull();
    const runsAfterQuestion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    expect(runsAfterQuestion[`scheduled_prompt:${created.id}`]?.[0]?.status).toBe('question');
    expect(runsAfterQuestion[`scheduled_prompt:${created.id}`]?.[0]?.message).toBe('Should I continue?');
    expect(runsAfterQuestion[`scheduled_prompt:${created.id}`]?.[0]?.completed_at).toBeNull();

    const recorded = await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: scheduledRuns[0]!.id,
      status: 'success',
      completedAt: Date.now(),
    });
    expect(recorded).toBe(true);
    const runsAfterCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    expect(runsAfterCompletion[`scheduled_prompt:${created.id}`]?.[0]?.status).toBe('success');

    const deleted = await cronStub.deleteScheduledPrompt(workspaceId!, created.id);
    expect(deleted).toBe(true);
    const listAfterDelete = await cronStub.listScheduledPrompts(workspaceId!);
    expect(listAfterDelete).toHaveLength(0);
    const runsAfterDelete = await cronStub.listAutomationRuns(workspaceId!);
    expect(runsAfterDelete[`scheduled_prompt:${created.id}`]).toBeUndefined();
  });

  it('does not let an older scheduled prompt completion overwrite the latest run summary', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Stale Prompt Owner');
    const { org } = await createOrg(testEnv, 'Stale Prompt Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Stale digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });

    await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    const runsAfterFirst = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const firstRun = runsAfterFirst[`scheduled_prompt:${created.id}`]?.[0];
    expect(firstRun?.id).toBeTypeOf('string');

    await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    const beforeStaleCompletion = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(beforeStaleCompletion).toBeDefined();

    const staleRecorded = await cronStub.recordScheduledPromptRunResult({
      workspaceId: workspaceId!,
      promptId: created.id,
      runId: firstRun!.id,
      status: 'error',
      message: 'Older run failed late',
    });
    expect(staleRecorded).toBe(true);

    const afterStaleCompletion = (await cronStub.listScheduledPrompts(workspaceId!))[0];
    expect(afterStaleCompletion?.last_run_at).toBe(beforeStaleCompletion?.last_run_at);
    expect(afterStaleCompletion?.last_run_status).toBe(
      beforeStaleCompletion?.last_run_status,
    );
    expect(afterStaleCompletion?.last_run_error).toBe(
      beforeStaleCompletion?.last_run_error,
    );

    const runsAfterStaleCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const firstRunHistory = runsAfterStaleCompletion[
      `scheduled_prompt:${created.id}`
    ]?.find((run) => run.id === firstRun!.id);
    expect(firstRunHistory?.status).toBe('error');
    expect(firstRunHistory?.message).toBe('Older run failed late');
  });

  it('creates, validates, versions, and deletes deterministic automations', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Automation Owner');
    const { org } = await createOrg(testEnv, 'Automation Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const invalid = await cronStub.validateDeterministicAutomationSource('export default {};');
    expect(invalid.valid).toBe(false);
    expect(invalid.errors.join('\n')).toContain('AutomationWorkflow');

    const valid = await cronStub.validateDeterministicAutomationSource(automationSource());
    expect(valid).toEqual({ valid: true, errors: [] });

    const automationTools = new CodeModeDeterministicAutomations({
      cronStub,
      workspaceId: workspaceId!,
      userId,
    });

    await expect(
      automationTools.create({
        name: 'Missing description sync',
        source: automationSource(),
        cron_expression: '0 9 * * *',
        enabled: false,
      }),
    ).rejects.toThrow('description is required');

    await expect(
      automationTools.create({
        name: 'Blank description sync',
        description: '   ',
        source: automationSource(),
        cron_expression: '0 9 * * *',
        enabled: false,
      }),
    ).rejects.toThrow('description is required');

    const created = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Daily deterministic sync',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '0 9 * * *',
      createdBy: userId,
      enabled: false,
    });

    expect(created.id).toBeTypeOf('string');
    expect(created.description).toBe('Runs deterministic workflow code.');
    expect(created.source_version).toBe(1);
    expect(created.enabled).toBe(false);
    expect(created.next_run_at).toBeNull();

    const snapshot = await cronStub.getDeterministicAutomationSource(
      workspaceId!,
      created.id,
      1,
    );
    expect(snapshot?.source).toContain('class AutomationWorkflow');
    expect(snapshot?.created_by).toBe(userId);

    await expect(
      automationTools.update({
        automation_id: created.id,
        description: null,
      } as Record<string, unknown>),
    ).rejects.toThrow('description must be a string');

    const updated = await cronStub.updateDeterministicAutomation({
      workspaceId: workspaceId!,
      id: created.id,
      source: automationSource('updated'),
      enabled: true,
    });
    expect(updated?.source_version).toBe(2);
    expect(updated?.enabled).toBe(true);
    expect(updated?.next_run_at).toBeTypeOf('number');

    const previousVersion = await cronStub.getDeterministicAutomationSource(
      workspaceId!,
      created.id,
      1,
    );
    expect(previousVersion?.source).toContain('ok');
    const currentVersion = await cronStub.getDeterministicAutomationSource(
      workspaceId!,
      created.id,
      2,
    );
    expect(currentVersion?.source).toContain('updated');

    const listAfterCreate = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterCreate).toHaveLength(1);
    expect(listAfterCreate[0]?.name).toBe('Daily deterministic sync');

    const run = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);
    expect(run?.dispatch.status).toBe('started');
    expect(run?.dispatch.instance_id).toBeTypeOf('string');
    expect(run?.automation.last_run_status).toBe('started');
    const runsAfterStart = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const workflowRuns = runsAfterStart[`deterministic_automation:${created.id}`] ?? [];
    expect(workflowRuns).toHaveLength(1);
    expect(workflowRuns[0]?.status).toBe('started');
    expect(workflowRuns[0]?.instance_id).toBe(run?.dispatch.instance_id);

    const staleCompletion = await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: 'different-instance',
      status: 'success',
    });
    expect(staleCompletion).toBe(false);
    const listAfterStaleCompletion = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterStaleCompletion[0]?.last_run_status).toBe('started');

    const completion = await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: run!.dispatch.instance_id!,
      status: 'success',
    });
    expect(completion).toBe(true);
    const listAfterCompletion = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterCompletion[0]?.last_run_status).toBe('success');
    expect(listAfterCompletion[0]?.last_run_error).toBeNull();
    const runsAfterCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    expect(runsAfterCompletion[`deterministic_automation:${created.id}`]?.[0]?.status).toBe('success');
    expect(runsAfterCompletion[`deterministic_automation:${created.id}`]?.[0]?.completed_at).toBeTypeOf('number');

    const deleted = await cronStub.deleteDeterministicAutomation(workspaceId!, created.id);
    expect(deleted).toBe(true);
    const listAfterDelete = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterDelete).toHaveLength(0);
    const runsAfterDelete = await cronStub.listAutomationRuns(workspaceId!);
    expect(runsAfterDelete[`deterministic_automation:${created.id}`]).toBeUndefined();
  });

  it('records stale deterministic completions in run history without overwriting the latest run summary', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Stale Workflow Owner');
    const { org } = await createOrg(testEnv, 'Stale Workflow Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createDeterministicAutomation({
      workspaceId: workspaceId!,
      name: 'Stale workflow',
      description: 'Runs deterministic workflow code.',
      source: automationSource(),
      cronExpression: '0 9 * * *',
      createdBy: userId,
      enabled: false,
    });

    const first = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);
    expect(first?.dispatch.instance_id).toBeTypeOf('string');
    const second = await cronStub.runDeterministicAutomationNow(workspaceId!, created.id);
    expect(second?.dispatch.instance_id).toBeTypeOf('string');
    const beforeStaleCompletion = (await cronStub.listDeterministicAutomations(
      workspaceId!,
    ))[0];
    expect(beforeStaleCompletion?.last_instance_id).toBe(second?.dispatch.instance_id);
    expect(beforeStaleCompletion?.last_run_status).toBe('started');

    const staleRecorded = await cronStub.recordDeterministicAutomationRunResult({
      workspaceId: workspaceId!,
      automationId: created.id,
      instanceId: first!.dispatch.instance_id!,
      status: 'success',
    });
    expect(staleRecorded).toBe(true);

    const afterStaleCompletion = (await cronStub.listDeterministicAutomations(
      workspaceId!,
    ))[0];
    expect(afterStaleCompletion?.last_instance_id).toBe(second?.dispatch.instance_id);
    expect(afterStaleCompletion?.last_run_status).toBe('started');

    const runsAfterStaleCompletion = await cronStub.listAutomationRuns(workspaceId!, {
      limitPerAutomation: 5,
    });
    const firstRunHistory = runsAfterStaleCompletion[
      `deterministic_automation:${created.id}`
    ]?.find((run) => run.instance_id === first!.dispatch.instance_id);
    expect(firstRunHistory?.status).toBe('success');
    expect(firstRunHistory?.completed_at).toBeTypeOf('number');
  });

  it('keyset-paginates retained run history with the 20-row cap', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Runs Owner');
    const { org } = await createOrg(testEnv, 'Runs Org', userId);
    const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
    const workspaceId = workspaces[0]?.id;
    expect(workspaceId).toBeTypeOf('string');

    const cronStub = testEnv.WORKSPACE_CRON.get(
      testEnv.WORKSPACE_CRON.idFromName(workspaceId!)
    ) as DurableObjectStub<WorkspaceCronDO>;

    const created = await cronStub.createScheduledPrompt({
      workspaceId: workspaceId!,
      name: 'Paginated digest',
      prompt: 'Summarize workspace status.',
      cronExpression: '0 9 * * *',
      createdBy: userId,
    });

    // Each manual run inserts one run-history row. Retention intentionally
    // keeps only the newest 20 rows for this pass.
    const TOTAL = 25;
    const RETAINED = 20;
    for (let i = 0; i < TOTAL; i++) {
      await cronStub.runScheduledPromptNow(workspaceId!, created.id);
    }

    const all = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: created.id,
      limit: 50,
    });
    expect(all.runs).toHaveLength(RETAINED);
    expect(all.nextCursor).toBeNull();

    // Walking small pages must reproduce the canonical newest-first order with
    // no overlap and no gaps, and terminate with a null cursor.
    const paged: string[] = [];
    let cursor: AutomationRunCursor | null = null;
    let pages = 0;
    do {
      const page = await cronStub.listAutomationRunsPage(workspaceId!, {
        kind: 'scheduled_prompt',
        automationId: created.id,
        limit: 5,
        cursor,
      });
      expect(page.runs.length).toBeLessThanOrEqual(5);
      paged.push(...page.runs.map((run) => run.id));
      cursor = page.nextCursor;
      pages++;
    } while (cursor && pages < 20);

    expect(cursor).toBeNull();
    expect(paged).toEqual(all.runs.map((run) => run.id));
    expect(new Set(paged).size).toBe(RETAINED);

    // An unrelated automation id returns an empty, terminal page.
    const empty = await cronStub.listAutomationRunsPage(workspaceId!, {
      kind: 'scheduled_prompt',
      automationId: 'does-not-exist',
      limit: 5,
    });
    expect(empty.runs).toHaveLength(0);
    expect(empty.nextCursor).toBeNull();
  });
});
