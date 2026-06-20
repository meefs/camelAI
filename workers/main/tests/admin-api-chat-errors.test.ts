import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { getAppIndexDatabase } from '../src/app-index-db';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import type { TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function unique(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Deterministic, well-separated fixture bases so the shared app-index D1 can't
// leak events across chat-error fixture windows (see admin-index-chat-errors).
// This file uses a distinct origin range from admin-index-chat-errors.
const API_CHAT_ERROR_FIXTURE_BASE_ORIGIN = 2_000_000_000;
const API_CHAT_ERROR_FIXTURE_BASE_SPACING = 1_000_000;
let apiChatErrorFixtureSequence = 0;

function adminEnv(): WorkerEnv {
  return {
    ...testEnv,
    ADMIN_API_KEY: 'test-admin-api-key',
  } as unknown as WorkerEnv;
}

async function adminGet(path: string): Promise<Response> {
  const request = new Request(`http://example/api/admin${path}`, {
    headers: {
      Authorization: 'Bearer test-admin-api-key',
    },
  });
  const response = await handleAdminApi({
    req: request,
    env: adminEnv(),
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
  if (!response) throw new Error('Admin API did not handle request');
  return response;
}

async function seedApiChatErrors(prefix = unique('api-chat-errors')) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  const base =
    API_CHAT_ERROR_FIXTURE_BASE_ORIGIN +
    apiChatErrorFixtureSequence++ * API_CHAT_ERROR_FIXTURE_BASE_SPACING;
  const userId = `${prefix}-user`;
  const orgId = `${prefix}-org`;
  const workspaceId = `${prefix}-workspace`;
  const threadId = `${prefix}-thread`;
  const fingerprint = `${prefix}-fingerprint`;

  await appIndex.applyAdminEvent({
    type: 'user_upsert',
    payload: {
      id: userId,
      email: `${prefix}@example.com`,
      name: `${prefix} User`,
      created_at: base - 10_000,
      avatar: { color: '#111111', content: 'U' },
    },
  });
  await appIndex.applyAdminEvent({
    type: 'org_upsert',
    payload: {
      id: orgId,
      name: `${prefix} Org`,
      created_at: base - 9_000,
      created_by: userId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'workspace_upsert',
    payload: {
      id: workspaceId,
      name: `${prefix} Workspace`,
      org_id: orgId,
      created_at: base - 8_000,
      created_by: userId,
      archived: false,
    },
  });
  await appIndex.applyAdminEvent({
    type: 'thread_upsert',
    payload: {
      id: threadId,
      title: `${prefix} Thread`,
      model: 'sonnet',
      org_id: orgId,
      workspace_id: workspaceId,
      created_by: userId,
      created_at: base - 7_000,
      updated_at: base + 2_000,
    },
  });
  for (const [index, createdAt] of [base + 1_000, base + 2_000].entries()) {
    await appIndex.applyAdminEvent({
      type: 'thread_error_recorded',
      payload: {
        id: `${threadId}:${createdAt}:${fingerprint}`,
        fingerprint,
        thread_id: threadId,
        org_id: orgId,
        workspace_id: workspaceId,
        user_id: userId,
        created_at: createdAt,
        source: 'pi_provider',
        error_kind: 'rate_limit',
        status: 429,
        provider: 'openai',
        model: 'gpt-5.4-mini',
        message_normalized: 'Provider returned [id]',
        message_sample: `Provider returned request ${index}`,
      },
    });
  }
  await appIndex.markBootstrapComplete();

  return {
    base,
    orgId,
    workspaceId,
    threadId,
    fingerprint,
  };
}

describe('admin API chat errors route', () => {
  it('returns query metadata, summary, groups, and breakdowns by default', async () => {
    const fixture = await seedApiChatErrors();
    const response = await adminGet(
      `/chat-errors?from=${fixture.base}&to=${fixture.base + 3_000}&org_id=${encodeURIComponent(fixture.orgId)}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      query: {
        from: fixture.base,
        to: fixture.base + 3_000,
        range: null,
        filters: { org_id: fixture.orgId },
        limit: 50,
        offset: 0,
        threads_limit: 50,
        threads_offset: 0,
        events_limit: 0,
        events_offset: 0,
      },
      summary: {
        total_events: 2,
        affected_threads: 1,
        distinct_groups: 1,
        latest_error_at: fixture.base + 2_000,
      },
      groups: [
        expect.objectContaining({
          fingerprint: fixture.fingerprint,
          count: 2,
          affected_thread_count: 1,
        }),
      ],
      breakdowns: {
        source: [expect.objectContaining({ value: 'pi_provider', count: 2 })],
        status: [expect.objectContaining({ value: 429, count: 2 })],
      },
    });
  });

  it('includes affected threads by default when fingerprint is supplied', async () => {
    const fixture = await seedApiChatErrors();
    const response = await adminGet(
      `/chat-errors?from=${fixture.base}&to=${fixture.base + 3_000}&fingerprint=${encodeURIComponent(fixture.fingerprint)}`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      threads: [
        expect.objectContaining({
          thread_id: fixture.threadId,
          workspace_id: fixture.workspaceId,
          count: 2,
        }),
      ],
    });
  });

  it('includes recent events only when requested with a positive event limit', async () => {
    const fixture = await seedApiChatErrors();
    const response = await adminGet(
      `/chat-errors?from=${fixture.base}&to=${fixture.base + 3_000}&fingerprint=${encodeURIComponent(fixture.fingerprint)}&include_events=true&events_limit=1`,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      events: [
        expect.objectContaining({
          fingerprint: fixture.fingerprint,
          thread_id: fixture.threadId,
          created_at: fixture.base + 2_000,
          message_sample: 'Provider returned request 1',
        }),
      ],
    });
  });

  it('rejects invalid and excessive time windows', async () => {
    const invalid = await adminGet('/chat-errors?from=2000&to=1000');
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      error: 'Invalid time window: from must be before to',
    });

    const excessive = await adminGet('/chat-errors?from=0&to=7776000001');
    expect(excessive.status).toBe(400);
    await expect(excessive.json()).resolves.toMatchObject({
      error: 'Invalid time window: maximum range is 90 days',
    });
  });

  it('rejects out-of-bounds limits during query validation', async () => {
    const response = await adminGet('/chat-errors?limit=201');
    expect(response.status).toBe(400);
  });
});
