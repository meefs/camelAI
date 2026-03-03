import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createUser,
  createOrg,
  type TestEnv,
} from './test-helpers';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OrgDO thread pagination filters', () => {
  const testEnv = env as unknown as TestEnv;

  it('applies created_by filtering before limit', async () => {
    const { userId: authorId } = await createUser(testEnv, testEmail(), 'password123', 'Author');
    const { userId: teammateId } = await createUser(testEnv, testEmail(), 'password123', 'Teammate');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Recent Threads Org', authorId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const authorThreadIds = new Set<string>();
    for (let i = 0; i < 6; i += 1) {
      const thread = await orgStub.createThread(defaultWorkspaceId, `Author Thread ${i}`, authorId);
      authorThreadIds.add(thread.id);
    }

    // Ensure teammate threads are newer than author threads.
    await sleep(20);

    for (let i = 0; i < 25; i += 1) {
      await orgStub.createThread(defaultWorkspaceId, `Teammate Thread ${i}`, teammateId);
    }

    const result = await orgStub.getThreadsPaginated(0, 6, defaultWorkspaceId, authorId);

    expect(result.items).toHaveLength(6);
    expect(result.total).toBe(6);
    expect(result.items.every((thread) => thread.created_by === authorId)).toBe(true);
    expect(new Set(result.items.map((thread) => thread.id))).toEqual(authorThreadIds);
  });
});
