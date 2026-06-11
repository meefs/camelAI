import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { normalizeBillingPlan } from '../../../src/lib/billing-plans';
import { getAppIndexDatabase } from '../src/app-index-db';
import type { TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function upsertUser(id: string, email: string, name = 'Explorer User') {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'user_upsert',
    payload: {
      id,
      email,
      name,
      created_at: Date.now(),
      avatar: { color: '#111111', content: 'U' },
    },
  });
}

async function upsertOrg(params: {
  id: string;
  name: string;
  createdBy?: string;
  billingPlan?: string | null;
  billingStatus?: string | null;
}) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'org_upsert',
    payload: {
      id: params.id,
      name: params.name,
      created_at: Date.now(),
      created_by: params.createdBy ?? null,
      billing_plan: params.billingPlan,
      billing_status: params.billingStatus,
      archived: false,
    },
  });
}

async function upsertWorkspace(id: string, orgId: string, name: string) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'workspace_upsert',
    payload: {
      id,
      name,
      org_id: orgId,
      created_at: Date.now(),
      archived: false,
    },
  });
}

async function upsertThread(params: {
  id: string;
  title: string;
  orgId: string;
  workspaceId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  firstUserMessage?: string | null;
  userMessageCount?: number | null;
  lastUserMessageAt?: number | null;
  source?: string | null;
  channelKind?: string | null;
  channelKinds?: string[] | string | null;
}) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'thread_upsert',
    payload: {
      id: params.id,
      title: params.title,
      model: 'sonnet',
      org_id: params.orgId,
      workspace_id: params.workspaceId,
      created_by: params.createdBy,
      created_at: params.createdAt,
      updated_at: params.updatedAt,
      first_user_message: params.firstUserMessage,
      user_message_count: params.userMessageCount,
      last_user_message_at: params.lastUserMessageAt,
      source: params.source,
      channel_kind: params.channelKind,
      channel_kinds: params.channelKinds,
    },
  });
}

describe('D1 admin chat explorer index', () => {
  it('persists enriched org and thread fields from admin events', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-fields');
    const userId = `${prefix}-user`;
    const reassignedUserId = `${prefix}-user-reassigned`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const threadId = `${prefix}-thread`;
    const reassignedEarlierThreadId = `${prefix}-thread-reassigned-earlier`;
    const reassignedTitle = `${prefix}-reassigned`;
    const longMessage = 'x'.repeat(350);

    await upsertUser(userId, `${prefix}@example.com`);
    await upsertUser(reassignedUserId, `${prefix}-reassigned@example.com`);
    await upsertOrg({
      id: orgId,
      name: `${prefix} Org`,
      createdBy: userId,
      billingPlan: 'free',
      billingStatus: 'trialing',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: threadId,
      title: `${prefix} Title`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 2_000,
      firstUserMessage: longMessage,
      userMessageCount: 7,
      lastUserMessageAt: 1_500,
      source: 'channel',
      channelKind: 'slack',
      channelKinds: ['slack', 'email'],
    });

    const initial = await appIndex.getChatExplorerThreads(0, 10, prefix);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({
      id: threadId,
      user_message_count: 7,
      first_user_message: 'x'.repeat(300),
      last_user_message_at: 1_500,
      source: 'channel',
      channel_kind: 'slack',
      channel_kinds: JSON.stringify(['slack', 'email']),
      org_billing_plan: 'free',
      org_billing_status: 'trialing',
      org_plan: 'payg',
      user_email: `${prefix}@example.com`,
    });

    await upsertThread({
      id: threadId,
      title: `${prefix} Updated`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 3_000,
      firstUserMessage: 'updated preview',
      userMessageCount: 9,
      lastUserMessageAt: 2_500,
      source: 'email',
      channelKind: 'email',
      channelKinds: '["email"]',
    });

    const updated = await appIndex.getChatExplorerThreads(0, 10, prefix);
    expect(updated.items[0]).toMatchObject({
      title: `${prefix} Updated`,
      user_message_count: 9,
      first_user_message: 'updated preview',
      last_user_message_at: 2_500,
      source: 'email',
      channel_kind: 'email',
      channel_kinds: '["email"]',
    });

    await upsertThread({
      id: reassignedEarlierThreadId,
      title: `${prefix} Earlier reassigned user thread`,
      orgId,
      workspaceId,
      createdBy: reassignedUserId,
      createdAt: 500,
      updatedAt: 750,
      firstUserMessage: 'older reassigned user thread',
      userMessageCount: 1,
    });
    await upsertThread({
      id: threadId,
      title: reassignedTitle,
      orgId,
      workspaceId,
      createdBy: reassignedUserId,
      createdAt: 1_000,
      updatedAt: Date.now() + 60_000,
      firstUserMessage: 'reassigned preview',
      userMessageCount: 10,
    });

    const reassigned = await appIndex.getChatExplorerThreads(0, 50);
    const reassignedRow = reassigned.items.find((row) => row.id === threadId);
    expect(reassignedRow).toMatchObject({
      id: threadId,
      user_email: `${prefix}-reassigned@example.com`,
      is_first_thread: false,
    });
  });

  it('searches, filters, sorts, and paginates explorer rows', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-query');
    const emailToken = unique('explorer-email');
    const orgToken = unique('explorer-org');
    const sharedTitleToken = unique('explorer-shared');
    const internalTitleToken = unique('explorer-internal');
    const userId = `${prefix}-user`;
    const internalUserId = `${prefix}-internal-user`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const firstThreadId = `${prefix}-thread-a`;
    const laterThreadId = `${prefix}-thread-b`;
    const systemThreadId = `${prefix}-thread-system`;
    const internalThreadId = `${prefix}-thread-internal`;
    const scheduledTitleThreadId = `${prefix}-thread-scheduled-title`;
    const missingUserThreadId = `${prefix}-thread-missing-user`;

    await upsertUser(userId, `${emailToken}@example.com`, 'First Human');
    await upsertUser(internalUserId, `${prefix}@camelai.com`, 'Internal Human');
    await upsertOrg({
      id: orgId,
      name: `${orgToken} Search Org`,
      createdBy: userId,
      billingPlan: 'pro',
      billingStatus: 'active',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: firstThreadId,
      title: `${sharedTitleToken} first`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 5_000,
      firstUserMessage: 'first human message',
      userMessageCount: 1,
      source: 'web',
    });
    await upsertThread({
      id: laterThreadId,
      title: `${sharedTitleToken} later`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 2_000,
      updatedAt: 6_000,
      firstUserMessage: 'later human message',
      userMessageCount: 2,
      source: 'web',
    });
    await upsertThread({
      id: systemThreadId,
      title: `${sharedTitleToken} system`,
      orgId,
      workspaceId,
      createdBy: 'system',
      createdAt: 500,
      updatedAt: 7_000,
      firstUserMessage: 'system message',
      userMessageCount: null,
      source: 'scheduled',
    });
    await upsertThread({
      id: internalThreadId,
      title: `${internalTitleToken} Internal`,
      orgId,
      workspaceId,
      createdBy: internalUserId,
      createdAt: 3_000,
      updatedAt: 8_000,
      firstUserMessage: 'internal message',
      userMessageCount: 1,
      source: 'web',
    });
    await upsertThread({
      id: scheduledTitleThreadId,
      title: `Scheduled: ${orgToken} title fallback`,
      orgId,
      workspaceId,
      createdBy: 'system',
      createdAt: 4_000,
      updatedAt: 9_000,
      firstUserMessage: 'scheduled title fallback',
      userMessageCount: 1,
      source: 'web',
    });
    await upsertThread({
      id: missingUserThreadId,
      title: `${orgToken} missing user ordinary`,
      orgId,
      workspaceId,
      createdBy: `${prefix}-missing-user`,
      createdAt: 4_500,
      updatedAt: 10_000,
      firstUserMessage: 'ordinary missing user',
      userMessageCount: 1,
      source: 'web',
    });

    await expect(appIndex.getChatExplorerThreads(0, 10, emailToken)).resolves.toMatchObject({
      total: 2,
    });
    await expect(appIndex.getChatExplorerThreads(0, 10, orgToken)).resolves.toMatchObject({
      total: 6,
    });
    await expect(appIndex.getChatExplorerThreads(0, 10, internalTitleToken)).resolves.toMatchObject({
      total: 1,
    });

    const firstOnly = await appIndex.getChatExplorerThreads(0, 10, sharedTitleToken, {
      first_chats_only: true,
    });
    expect(firstOnly.items.map((row) => row.id)).toEqual([firstThreadId]);
    expect(firstOnly.items[0]?.is_first_thread).toBe(true);

    const excludeInternal = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      exclude_internal: true,
    });
    expect(excludeInternal.items.map((row) => row.id)).toEqual([
      missingUserThreadId,
      scheduledTitleThreadId,
      systemThreadId,
      laterThreadId,
      firstThreadId,
    ]);

    const createdSort = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      exclude_internal: true,
      sort_by: 'created_at',
    });
    expect(createdSort.items.map((row) => row.id)).toEqual([
      missingUserThreadId,
      scheduledTitleThreadId,
      laterThreadId,
      firstThreadId,
      systemThreadId,
    ]);

    const page = await appIndex.getChatExplorerThreads(0, 2, orgToken, {
      exclude_internal: true,
    });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const proRows = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      plan: 'pro',
    });
    expect(proRows.total).toBe(6);
    const starterRows = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      plan: 'starter',
    });
    expect(starterRows.total).toBe(0);

    const automatedOnly = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      automated_only: true,
    });
    expect(automatedOnly.items.map((row) => row.id)).toEqual([
      scheduledTitleThreadId,
      systemThreadId,
    ]);
    expect(automatedOnly.items.map((row) => row.id)).not.toContain(missingUserThreadId);
  });

  it('keeps SQL plan normalization aligned with normalizeBillingPlan', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-plan');
    const userId = `${prefix}-user`;
    await upsertUser(userId, `${prefix}@example.com`);

    const cases: Array<[string | null, Parameters<typeof normalizeBillingPlan>[1]]> = [
      [null, null],
      ['free', 'trialing'],
      ['free', null],
      ['payg', 'active'],
      ['starter', 'active'],
      ['pro', null],
      ['team', 'past_due'],
      [null, 'trialing'],
      [null, 'enterprise'],
      ['enterprise', null],
      ['garbage', 'active'],
    ];

    for (const [index, [billingPlan, billingStatus]] of cases.entries()) {
      const orgId = `${prefix}-org-${index}`;
      const workspaceId = `${prefix}-workspace-${index}`;
      const threadId = `${prefix}-thread-${index}`;
      await upsertOrg({
        id: orgId,
        name: `${prefix} Org ${index}`,
        createdBy: userId,
        billingPlan,
        billingStatus,
      });
      await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace ${index}`);
      await upsertThread({
        id: threadId,
        title: `${prefix}-plan-thread-${index}`,
        orgId,
        workspaceId,
        createdBy: userId,
        createdAt: 10_000 + index,
        updatedAt: Date.now() + 1_000_000 + index,
        firstUserMessage: 'plan parity',
        userMessageCount: 1,
      });

      const expectedPlan = normalizeBillingPlan(billingPlan, billingStatus);
      const result = await appIndex.getChatExplorerThreads(0, 100, undefined, {
        plan: expectedPlan === 'free' ? 'payg' : expectedPlan,
      });
      expect(result.items.map((row) => row.id)).toContain(threadId);
      expect(result.items.find((row) => row.id === threadId)?.org_plan).toBe(expectedPlan);
    }
  });
});
