import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { OrgDO } from '../src/auth';
import type { WorkspaceCronDO } from '../src/workspace-cron';
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

    const deleted = await cronStub.deleteScheduledPrompt(workspaceId!, created.id);
    expect(deleted).toBe(true);
    const listAfterDelete = await cronStub.listScheduledPrompts(workspaceId!);
    expect(listAfterDelete).toHaveLength(0);
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

    const deleted = await cronStub.deleteDeterministicAutomation(workspaceId!, created.id);
    expect(deleted).toBe(true);
    const listAfterDelete = await cronStub.listDeterministicAutomations(workspaceId!);
    expect(listAfterDelete).toHaveLength(0);
  });
});
