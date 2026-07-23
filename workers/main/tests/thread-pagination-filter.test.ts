import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import {
  createUser,
  createOrg,
  createWorkspace,
  type TestEnv,
} from './test-helpers';
import {
  THREAD_ASK_LOG_MAX_BYTES,
  THREAD_SEARCH_FIELD_MAX_CHARS,
} from '../../../src/lib/thread-search';

const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('OrgDO thread pagination filters', () => {
  const testEnv = env as unknown as TestEnv;

  it('finds a title match beyond the first unfiltered page', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Deep History Search Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const target = await orgStub.createThread(
      defaultWorkspaceId,
      'Unique antique pomodoro',
      userId,
    );
    await sleep(20);
    for (let index = 0; index < 59; index += 1) {
      await orgStub.createThread(defaultWorkspaceId, `Recent thread ${index}`, userId);
    }

    const firstPage = await orgStub.getThreadsPaginated(0, 50, defaultWorkspaceId);
    expect(firstPage.items.map((thread) => thread.id)).not.toContain(target.id);

    const result = await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'antique',
    );
    expect(result.total).toBe(1);
    expect(result.items.map((thread) => thread.id)).toEqual([target.id]);
  }, 30_000);

  it('searches existing thread metadata with escaping and AND semantics', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Metadata Search Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const firstMessageThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Ordinary title',
      userId,
      'Please build a lunar calendar',
    );
    const lastMessageThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Another ordinary title',
      userId,
    );
    await orgStub.recordThreadUserMessage(lastMessageThread.id, 'Investigate a cobalt failure');

    const summaryThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Summary-only thread',
      userId,
    );
    await orgStub.recordThreadAssistantCompletion(summaryThread.id, {
      completedAt: Date.now() + 10,
      summary: 'Resolved the hidden marigold issue.',
    });

    const crossFieldThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Alpha planning',
      userId,
    );
    await orgStub.recordThreadUserMessage(crossFieldThread.id, 'The beta requirement');

    const percentThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Reached 100% completion',
      userId,
    );
    await orgStub.createThread(defaultWorkspaceId, 'Plain completion', userId);

    const firstResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'LUNAR',
    );
    expect(firstResult.items.map((thread) => thread.id)).toEqual([firstMessageThread.id]);

    const lastResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'cobalt',
    );
    expect(lastResult.items.map((thread) => thread.id)).toEqual([lastMessageThread.id]);

    const summaryResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'marigold',
    );
    expect(summaryResult.items.map((thread) => thread.id)).toEqual([summaryThread.id]);

    const multiTermResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'alpha beta',
    );
    expect(multiTermResult.items.map((thread) => thread.id)).toEqual([crossFieldThread.id]);
    const missingTermResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'alpha absent',
    );
    expect(missingTermResult.total).toBe(0);

    const escapedResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, '%',
    );
    expect(escapedResult.items.map((thread) => thread.id)).toEqual([percentThread.id]);
  }, 20_000);

  it('case-folds Unicode titles across create, rename, and migration backfill', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Unicode Title Search Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'café planning',
      userId,
    );

    expect((await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'CAFÉ',
    )).items.map((entry) => entry.id)).toEqual([thread.id]);

    await orgStub.updateThread(thread.id, 'NAÏVE rollout', userId);
    expect((await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'naïve',
    )).items.map((entry) => entry.id)).toEqual([thread.id]);

    await orgStub.downgradeThreadSchemaForTest();
    await orgStub.remigrate();
    expect((await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'NAÏVE',
    )).items.map((entry) => entry.id)).toEqual([thread.id]);
  }, 20_000);

  it('checkpoints the legacy search metadata backfill in bounded batches', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Search Backfill Checkpoint Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    for (let index = 0; index < 3; index += 1) {
      await orgStub.createThread(
        defaultWorkspaceId,
        `café migration ${index}`,
        userId,
      );
    }

    await orgStub.downgradeThreadSchemaForTest();
    await orgStub.remigrate();

    await expect(orgStub.runThreadSearchBackfillBatchForTest(1)).resolves.toEqual({
      processed: 1,
      complete: false,
    });
    await expect(orgStub.runThreadSearchBackfillBatchForTest(1)).resolves.toEqual({
      processed: 1,
      complete: false,
    });
    await expect(orgStub.runThreadSearchBackfillBatchForTest(1)).resolves.toEqual({
      processed: 1,
      complete: true,
    });
    await expect(orgStub.runThreadSearchBackfillBatchForTest(1)).resolves.toEqual({
      processed: 0,
      complete: true,
    });

    expect((await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'CAFÉ',
    )).total).toBe(3);
  }, 20_000);

  it('composes search with creator and workspace filters', async () => {
    const { userId: authorId } = await createUser(testEnv, testEmail(), 'password123', 'Author');
    const { userId: teammateId } = await createUser(testEnv, testEmail(), 'password123', 'Teammate');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Scoped Search Org',
      authorId,
    );
    const secondWorkspace = await createWorkspace(
      testEnv,
      org.id,
      'Secondary Search Workspace',
      authorId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const primary = await orgStub.createThread(
      defaultWorkspaceId,
      'Scoped needle primary',
      authorId,
    );
    const secondary = await orgStub.createThread(
      secondWorkspace.id,
      'Scoped needle secondary',
      authorId,
    );
    await orgStub.createThread(
      defaultWorkspaceId,
      'Scoped needle teammate',
      teammateId,
    );

    const workspaceResult = await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      authorId,
      'needle',
    );
    expect(workspaceResult.items.map((thread) => thread.id)).toEqual([primary.id]);

    const allWorkspaceResult = await orgStub.getThreadsAllWorkspacesPaginated(
      [defaultWorkspaceId, secondWorkspace.id],
      0,
      50,
      authorId,
      'needle',
    );
    expect(new Set(allWorkspaceResult.items.map((thread) => thread.id))).toEqual(
      new Set([primary.id, secondary.id]),
    );
    expect(allWorkspaceResult.total).toBe(2);
  }, 20_000);

  it('keeps a bounded ask log for mid-history recall and suppresses retries', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Ask Log Search Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    const recallThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Recall thread',
      userId,
    );
    await orgStub.recordThreadUserMessage(recallThread.id, 'First obsidian request');
    await orgStub.recordThreadUserMessage(recallThread.id, 'Middle request');
    await orgStub.recordThreadUserMessage(recallThread.id, 'Latest request');

    const recallResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'obsidian',
    );
    expect(recallResult.items.map((thread) => thread.id)).toEqual([recallThread.id]);
    expect(recallResult.items[0]?.user_ask_log).toContain('First obsidian request');
    expect((await orgStub.getThread(recallThread.id))?.last_user_message).toBe('Latest request');

    const duplicateThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Duplicate thread',
      userId,
    );
    await orgStub.recordThreadUserMessage(duplicateThread.id, 'same retry payload');
    await orgStub.recordThreadUserMessage(duplicateThread.id, 'same retry payload');
    const duplicateResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'same retry payload',
    );
    expect(duplicateResult.items[0]?.user_ask_log).toBe(
      'same retry payload',
    );

    const cappedThread = await orgStub.createThread(
      defaultWorkspaceId,
      'Capped thread',
      userId,
    );
    for (let index = 0; index < 20; index += 1) {
      const marker = index === 0
        ? 'oldestquartz'
        : index === 19
          ? 'newesttopaz'
          : `middle${index}`;
      await orgStub.recordThreadUserMessage(
        cappedThread.id,
        `${marker} ${String(index).padStart(2, '0')} ${'x'.repeat(520)}`,
      );
    }
    const newestResult = await orgStub.getThreadsPaginated(
      0, 50, defaultWorkspaceId, undefined, 'newesttopaz',
    );
    const capped = newestResult.items.find((thread) => thread.id === cappedThread.id);
    expect(
      new TextEncoder().encode(capped?.user_ask_log ?? '').byteLength,
    ).toBeLessThanOrEqual(THREAD_ASK_LOG_MAX_BYTES);
    expect(capped?.user_ask_log).not.toContain('oldestquartz');
    expect(capped?.user_ask_log).toContain('newesttopaz');

    expect(
      (await orgStub.getThreadsPaginated(
        0, 50, defaultWorkspaceId, undefined, 'oldestquartz',
      )).total,
    ).toBe(0);
    expect(newestResult.items.map((thread) => thread.id)).toContain(cappedThread.id);
  }, 20_000);

  it('returns ask logs only from active search pagination', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Ask Log Projection Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'Projection thread',
      userId,
    );
    const updated = await orgStub.recordThreadUserMessage(
      thread.id,
      'privateprojectionterm prompt',
    );

    const nonSearchResults = [
      updated,
      await orgStub.getThread(thread.id),
      ...(await orgStub.getThreads()),
      ...(await orgStub.getThreadsByWorkspace(defaultWorkspaceId)),
      ...(await orgStub.getThreadsByIds(defaultWorkspaceId, [thread.id])),
      ...(await orgStub.getThreadsPaginated(0, 50, defaultWorkspaceId)).items,
      ...(await orgStub.getThreadsPaginated(
        0, 50, defaultWorkspaceId, undefined, '   ',
      )).items,
      ...(await orgStub.getThreadsAllWorkspacesPaginated(
        [defaultWorkspaceId],
        0,
        50,
      )).items,
      ...(await orgStub.searchThreads('Projection')),
    ].filter((entry) => entry?.id === thread.id);

    expect(nonSearchResults.length).toBeGreaterThan(0);
    for (const result of nonSearchResults) {
      expect(result).not.toHaveProperty('user_ask_log');
    }

    const searchResult = await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'privateprojectionterm',
    );
    expect(searchResult.items).toHaveLength(1);
    expect(searchResult.items[0]?.user_ask_log).toBe(
      'privateprojectionterm prompt',
    );

    const allWorkspaceSearchResult = await orgStub.getThreadsAllWorkspacesPaginated(
      [defaultWorkspaceId],
      0,
      50,
      undefined,
      'privateprojectionterm',
    );
    expect(allWorkspaceSearchResult.items[0]?.user_ask_log).toBe(
      'privateprojectionterm prompt',
    );
  }, 20_000);

  it('searches and returns only bounded portions of message metadata', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password123', 'Searcher');
    const { org, defaultWorkspaceId } = await createOrg(
      testEnv,
      'Bounded Search Projection Org',
      userId,
    );
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'Bounded metadata thread',
      userId,
      `firstprefix ${'x'.repeat(THREAD_SEARCH_FIELD_MAX_CHARS)} firstbeyondcap`,
    );
    await orgStub.recordThreadUserMessage(
      thread.id,
      `lastprefix ${'y'.repeat(THREAD_SEARCH_FIELD_MAX_CHARS)} lastbeyondcap`,
    );

    const stored = await orgStub.getThread(thread.id);
    expect(stored?.first_user_message?.length).toBeGreaterThan(
      THREAD_SEARCH_FIELD_MAX_CHARS,
    );
    expect(stored?.last_user_message?.length).toBeGreaterThan(
      THREAD_SEARCH_FIELD_MAX_CHARS,
    );

    const withinCap = await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'firstprefix',
    );
    expect(withinCap.items.map((entry) => entry.id)).toEqual([thread.id]);
    expect(withinCap.items[0]?.first_user_message?.length).toBeLessThanOrEqual(
      THREAD_SEARCH_FIELD_MAX_CHARS,
    );
    expect(withinCap.items[0]?.last_user_message?.length).toBeLessThanOrEqual(
      THREAD_SEARCH_FIELD_MAX_CHARS,
    );

    expect((await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'firstbeyondcap',
    )).total).toBe(0);
    expect((await orgStub.getThreadsPaginated(
      0,
      50,
      defaultWorkspaceId,
      undefined,
      'lastbeyondcap',
    )).total).toBe(0);
  }, 20_000);

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
  }, 15_000);

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
  }, 15_000);

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
  }, 15_000);
});
