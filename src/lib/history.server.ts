import type { AppLoadContext } from 'react-router';
import type { Thread, ThreadCreator, User } from '@/types';
import type { AuthEnv } from './auth.server';
import type { RawThreadCreator } from './chat-do.server';
import * as chatDO from './chat-do.server';
import { loadUsersById } from './user-profiles.server';

export type HistoryScope = 'this-workspace' | 'all-workspaces';

interface HistoryPageQuery {
  scope: HistoryScope;
  orgId: string;
  workspaceId: string;
  accessibleWorkspaceIds: string[];
  offset?: number;
  limit?: number;
  createdBy?: string | null;
}

function toHydratedThread(thread: Thread, creator: User | undefined): Thread {
  return {
    ...thread,
    creator,
  };
}

async function hydrateUserProfiles(
  authEnv: AuthEnv,
  userIds: string[],
  options: {
    request?: Request;
    preloadedUsers?: Iterable<User | null | undefined>;
  } = {},
): Promise<Map<string, User>> {
  return loadUsersById(authEnv, userIds, options);
}

function toThreadCreator(
  rawCreator: RawThreadCreator,
  creator: User | undefined
): ThreadCreator {
  return {
    userId: rawCreator.created_by,
    name: creator?.name ?? null,
    email: creator?.email ?? rawCreator.created_by,
    avatar: creator?.avatar ?? null,
    threadCount: rawCreator.thread_count,
    latestUpdatedAt: rawCreator.latest_updated_at,
  };
}

export function getHistoryScope(searchParams: URLSearchParams): HistoryScope {
  const rawScope = searchParams.get('scope') ?? searchParams.get('filter');
  return rawScope === 'all-workspaces' ? 'all-workspaces' : 'this-workspace';
}

export function getHistoryCreatedBy(searchParams: URLSearchParams): string | null {
  const createdBy = searchParams.get('createdBy')?.trim();
  return createdBy ? createdBy : null;
}

export function buildHistoryQueryKey(
  scope: HistoryScope,
  scopeId: string,
  createdBy: string | null
): string {
  return `${scope}:${scopeId}:${createdBy ?? 'all'}`;
}

export async function fetchHistoryThreadsPage(
  context: AppLoadContext,
  query: HistoryPageQuery
) {
  const params = {
    offset: query.offset ?? 0,
    limit: query.limit ?? 50,
    createdBy: query.createdBy ?? undefined,
  };

  if (query.scope === 'all-workspaces') {
    return await chatDO.getThreadsPaginatedAllWorkspaces(
      context,
      query.accessibleWorkspaceIds,
      params,
      { orgId: query.orgId },
    );
  }

  return await chatDO.getThreadsPaginated(context, query.workspaceId, params, {
    orgId: query.orgId,
  });
}

export async function fetchHistoryThreadCreators(
  context: AppLoadContext,
  scope: HistoryScope,
  orgId: string,
  workspaceId: string,
  accessibleWorkspaceIds: string[]
): Promise<RawThreadCreator[]> {
  if (scope === 'all-workspaces') {
    return await chatDO.getThreadCreatorsAllWorkspaces(
      context,
      accessibleWorkspaceIds,
      { orgId },
    );
  }

  return await chatDO.getThreadCreators(context, workspaceId, { orgId });
}

export async function hydrateHistoryThreads(
  authEnv: AuthEnv,
  threads: Thread[],
  additionalUserIds: string[] = [],
  options: {
    request?: Request;
    preloadedUsers?: Iterable<User | null | undefined>;
  } = {},
): Promise<{ threads: Thread[]; userMap: Map<string, User> }> {
  const userMap = await hydrateUserProfiles(authEnv, [
    ...threads.map((thread) => thread.created_by),
    ...additionalUserIds,
  ], options);

  return {
    threads: threads.map((thread) =>
      toHydratedThread(thread, userMap.get(thread.created_by))
    ),
    userMap,
  };
}

export function hydrateHistoryThreadCreators(
  rawCreators: RawThreadCreator[],
  userMap: Map<string, User>
): ThreadCreator[] {
  return rawCreators.map((rawCreator) =>
    toThreadCreator(rawCreator, userMap.get(rawCreator.created_by))
  );
}
