import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createUser,
  createOrg,
  createWorkspace,
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

  it('applies created_by filtering across all workspaces before limit', async () => {
    const { userId: authorId } = await createUser(testEnv, testEmail(), 'password123', 'Author');
    const { userId: teammateId } = await createUser(testEnv, testEmail(), 'password123', 'Teammate');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Cross Workspace Threads Org', authorId);
    const secondWorkspace = await createWorkspace(
      testEnv,
      org.id,
      'Secondary Workspace',
      authorId
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const authorThreadIds = new Set<string>();
    for (let i = 0; i < 3; i += 1) {
      const thread = await orgStub.createThread(defaultWorkspaceId, `Author Primary ${i}`, authorId);
      authorThreadIds.add(thread.id);
    }
    for (let i = 0; i < 3; i += 1) {
      const thread = await orgStub.createThread(secondWorkspace.id, `Author Secondary ${i}`, authorId);
      authorThreadIds.add(thread.id);
    }

    await sleep(20);

    for (let i = 0; i < 20; i += 1) {
      const workspaceId = i % 2 === 0 ? defaultWorkspaceId : secondWorkspace.id;
      await orgStub.createThread(workspaceId, `Teammate Thread ${i}`, teammateId);
    }

    const result = await orgStub.getThreadsAllWorkspacesPaginated(
      [defaultWorkspaceId, secondWorkspace.id],
      0,
      6,
      authorId
    );

    expect(result.items).toHaveLength(6);
    expect(result.total).toBe(6);
    expect(result.items.every((thread) => thread.created_by === authorId)).toBe(true);
    expect(new Set(result.items.map((thread) => thread.id))).toEqual(authorThreadIds);
  });

  it('returns thread creators with counts ordered by latest activity', async () => {
    const { userId: authorId } = await createUser(testEnv, testEmail(), 'password123', 'Author');
    const { userId: teammateId } = await createUser(testEnv, testEmail(), 'password123', 'Teammate');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Creator Tabs Org', authorId);
    const secondWorkspace = await createWorkspace(
      testEnv,
      org.id,
      'Secondary Workspace',
      authorId
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await orgStub.createThread(defaultWorkspaceId, 'Author Default', authorId);
    await sleep(10);
    await orgStub.createThread(defaultWorkspaceId, 'Teammate Default', teammateId);
    await sleep(10);
    await orgStub.createThread(secondWorkspace.id, 'Author Secondary', authorId);

    const defaultCreators = await orgStub.getThreadCreators(defaultWorkspaceId);
    expect(defaultCreators).toEqual([
      expect.objectContaining({
        created_by: teammateId,
        thread_count: 1,
      }),
      expect.objectContaining({
        created_by: authorId,
        thread_count: 1,
      }),
    ]);

    const allWorkspaceCreators = await orgStub.getThreadCreatorsAllWorkspaces([
      defaultWorkspaceId,
      secondWorkspace.id,
    ]);
    expect(allWorkspaceCreators).toEqual([
      expect.objectContaining({
        created_by: authorId,
        thread_count: 2,
      }),
      expect.objectContaining({
        created_by: teammateId,
        thread_count: 1,
      }),
    ]);
    expect(allWorkspaceCreators[0]?.latest_updated_at).toBeGreaterThan(
      allWorkspaceCreators[1]?.latest_updated_at ?? 0
    );
  });
});
