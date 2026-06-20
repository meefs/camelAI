import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppIndexDatabase } from '../src/app-index-db';
import type { TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Chat-error breakdown/event queries filter by an absolute time window only, and
// the app-index D1 is shared across the worker test suite. A random Date.now()
// base let fixtures from this file (and admin-api-chat-errors) land in each
// other's window and double-count. Give each fixture a deterministic base spaced
// far apart, in a range distinct from the other chat-error fixture files.
const CHAT_ERROR_FIXTURE_BASE_ORIGIN = 1_000_000_000;
const CHAT_ERROR_FIXTURE_BASE_SPACING = 1_000_000;
let chatErrorFixtureSequence = 0;

async function upsertUser(id: string, email: string, name: string) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'user_upsert',
    payload: {
      id,
      email,
      name,
      created_at: Date.now(),
      avatar: { color: '#111111', content: name.slice(0, 1) || 'U' },
    },
  });
}

async function seedChatErrorFixture(prefix = unique('chat-errors')) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  const base =
    CHAT_ERROR_FIXTURE_BASE_ORIGIN +
    chatErrorFixtureSequence++ * CHAT_ERROR_FIXTURE_BASE_SPACING;
  const userAId = `${prefix}-user-a`;
  const userBId = `${prefix}-user-b`;
  const orgAId = `${prefix}-org-a`;
  const orgBId = `${prefix}-org-b`;
  const workspaceAId = `${prefix}-workspace-a`;
  const workspaceBId = `${prefix}-workspace-b`;
  const threadAId = `${prefix}-thread-a`;
  const threadBId = `${prefix}-thread-b`;
  const threadCId = `${prefix}-thread-c`;
  const fingerprintA = `${prefix}-fingerprint-a`;
  const fingerprintB = `${prefix}-fingerprint-b`;

  await upsertUser(userAId, `${prefix}-a@example.com`, `${prefix} User A`);
  await upsertUser(userBId, `${prefix}-b@example.com`, `${prefix} User B`);
  await appIndex.applyAdminEvent({
    type: 'org_upsert',
    payload: {
      id: orgAId,
      name: `${prefix} Org A`,
      created_at: base - 10_000,
      created_by: userAId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'org_upsert',
    payload: {
      id: orgBId,
      name: `${prefix} Org B`,
      created_at: base - 9_000,
      created_by: userBId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'workspace_upsert',
    payload: {
      id: workspaceAId,
      name: `${prefix} Workspace A`,
      org_id: orgAId,
      created_at: base - 8_000,
      created_by: userAId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'workspace_upsert',
    payload: {
      id: workspaceBId,
      name: `${prefix} Workspace B`,
      org_id: orgBId,
      created_at: base - 7_000,
      created_by: userBId,
      archived: false,
    },
  });

  for (const [threadId, title, orgId, workspaceId, createdBy] of [
    [threadAId, `${prefix} Thread A`, orgAId, workspaceAId, userAId],
    [threadBId, `${prefix} Thread B`, orgAId, workspaceAId, userBId],
    [threadCId, `${prefix} Thread C`, orgBId, workspaceBId, userBId],
  ] as const) {
    await appIndex.applyAdminEvent({
      type: 'thread_upsert',
      payload: {
        id: threadId,
        title,
        model: 'sonnet',
        org_id: orgId,
        workspace_id: workspaceId,
        created_by: createdBy,
        created_at: base - 6_000,
        updated_at: base + 4_000,
      },
    });
  }

  const eventA = {
    fingerprint: fingerprintA,
    org_id: orgAId,
    workspace_id: workspaceAId,
    source: 'pi_provider',
    error_kind: 'rate_limit',
    status: 429,
    provider: 'openai',
    model: 'gpt-5.4-mini',
    message_normalized: 'Provider returned [id]',
    message_sample: 'Provider returned request id abc123',
  };
  await appIndex.applyAdminEvent({
    type: 'thread_error_recorded',
    payload: {
      ...eventA,
      id: `${threadAId}:${base + 1_000}:${fingerprintA}`,
      thread_id: threadAId,
      user_id: userAId,
      created_at: base + 1_000,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'thread_error_recorded',
    payload: {
      ...eventA,
      id: `${threadAId}:${base + 2_000}:${fingerprintA}`,
      thread_id: threadAId,
      user_id: userBId,
      created_at: base + 2_000,
      message_sample: 'Provider returned request id def456',
    },
  });
  await appIndex.applyAdminEvent({
    type: 'thread_error_recorded',
    payload: {
      ...eventA,
      id: `${threadBId}:${base + 3_000}:${fingerprintA}`,
      thread_id: threadBId,
      user_id: userAId,
      created_at: base + 3_000,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'thread_error_recorded',
    payload: {
      id: `${threadCId}:${base + 4_000}:${fingerprintB}`,
      fingerprint: fingerprintB,
      thread_id: threadCId,
      org_id: orgBId,
      workspace_id: workspaceBId,
      user_id: userBId,
      created_at: base + 4_000,
      source: 'runner_send',
      error_kind: 'billing',
      status: 402,
      provider: null,
      model: 'sonnet',
      message_normalized: 'Billing failure',
      message_sample: 'Billing failure for workspace',
    },
  });
  await appIndex.applyAdminEvent({
    type: 'thread_error_recorded',
    payload: {
      ...eventA,
      id: `${threadAId}:${base - 1_000}:${fingerprintA}`,
      thread_id: threadAId,
      user_id: userAId,
      created_at: base - 1_000,
    },
  });

  return {
    appIndex,
    base,
    userAId,
    userBId,
    orgAId,
    orgBId,
    workspaceAId,
    workspaceBId,
    threadAId,
    threadBId,
    threadCId,
    fingerprintA,
    fingerprintB,
  };
}

describe('D1 admin chat error queries', () => {
  it('summarizes, groups, and deduplicates affected threads inside a filtered window', async () => {
    const fixture = await seedChatErrorFixture();
    const options = {
      startAt: fixture.base,
      endAt: fixture.base + 3_500,
      filters: { org_id: fixture.orgAId },
    };

    await expect(fixture.appIndex.getChatErrorSummary(options)).resolves.toEqual({
      total_events: 3,
      affected_threads: 2,
      distinct_groups: 1,
      latest_error_at: fixture.base + 3_000,
    });

    await expect(fixture.appIndex.getChatErrorGroups({ ...options, limit: 10 })).resolves.toEqual([
      expect.objectContaining({
        fingerprint: fixture.fingerprintA,
        count: 3,
        affected_thread_count: 2,
        first_seen_at: fixture.base + 1_000,
        last_seen_at: fixture.base + 3_000,
        status: 429,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        message_sample: 'Provider returned request id abc123',
      }),
    ]);

    await expect(
      fixture.appIndex.getChatErrorThreads({
        ...options,
        filters: { ...options.filters, fingerprint: fixture.fingerprintA },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        thread_id: fixture.threadBId,
        org_name: expect.stringContaining('Org A'),
        workspace_name: expect.stringContaining('Workspace A'),
        count: 1,
      }),
      expect.objectContaining({
        thread_id: fixture.threadAId,
        count: 2,
      }),
    ]);
  });

  it('applies exact metadata filters and substring search', async () => {
    const fixture = await seedChatErrorFixture();
    const baseOptions = {
      startAt: fixture.base,
      endAt: fixture.base + 5_000,
    };

    for (const filters of [
      { org_id: fixture.orgBId },
      { workspace_id: fixture.workspaceBId },
      { thread_id: fixture.threadCId },
      { user_id: fixture.userBId, fingerprint: fixture.fingerprintB },
      { source: 'runner_send' },
      { error_kind: 'billing' },
      { status: 402 },
      { model: 'sonnet' },
      { search: 'Billing failure' },
    ]) {
      await expect(
        fixture.appIndex.getChatErrorSummary({ ...baseOptions, filters }),
      ).resolves.toMatchObject({
        total_events: 1,
        affected_threads: 1,
        distinct_groups: 1,
      });
    }

    await expect(
      fixture.appIndex.getChatErrorSummary({
        ...baseOptions,
        filters: { provider: 'openai', source: 'pi_provider', error_kind: 'rate_limit' },
      }),
    ).resolves.toMatchObject({
      total_events: 3,
      affected_threads: 2,
      distinct_groups: 1,
    });
  });

  it('returns breakdowns and paginated recent events with joined metadata', async () => {
    const fixture = await seedChatErrorFixture();
    const options = {
      startAt: fixture.base,
      endAt: fixture.base + 5_000,
      filters: { search: 'failure' },
    };

    await expect(fixture.appIndex.getChatErrorBreakdowns(options)).resolves.toMatchObject({
      source: [expect.objectContaining({ value: 'runner_send', count: 1 })],
      error_kind: [expect.objectContaining({ value: 'billing', count: 1 })],
      status: [expect.objectContaining({ value: 402, count: 1 })],
      provider: [expect.objectContaining({ value: null, count: 1 })],
      model: [expect.objectContaining({ value: 'sonnet', count: 1 })],
    });

    await expect(
      fixture.appIndex.getChatErrorEvents({
        startAt: fixture.base,
        endAt: fixture.base + 5_000,
        limit: 2,
        offset: 0,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: `${fixture.threadCId}:${fixture.base + 4_000}:${fixture.fingerprintB}`,
        fingerprint: fixture.fingerprintB,
        title: expect.stringContaining('Thread C'),
        org_name: expect.stringContaining('Org B'),
        workspace_name: expect.stringContaining('Workspace B'),
        user_email: expect.stringContaining('-b@example.com'),
        message_sample: 'Billing failure for workspace',
      }),
      expect.objectContaining({
        id: `${fixture.threadBId}:${fixture.base + 3_000}:${fixture.fingerprintA}`,
        fingerprint: fixture.fingerprintA,
      }),
    ]);
  });
});
