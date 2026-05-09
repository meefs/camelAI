import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.history';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import * as chatDO from '@/lib/chat-do.server';
import { removeDeletedThreadFromOrgGroups } from '@/lib/chat-groups.server';
import { getEnv } from '@/lib/cloudflare.server';
import HistoryClient from '@/components/pages/history/history-client';
import { HistoryLoadingSkeleton } from '@/components/history/history-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import {
  buildHistoryQueryKey,
  fetchHistoryThreadCreators,
  fetchHistoryThreadsPage,
  getHistoryCreatedBy,
  getHistoryScope,
  hydrateHistoryThreadCreators,
  hydrateHistoryThreads,
} from '@/lib/history.server';

const PAGE_SIZE = 50;

export function meta() {
  return [
    { title: 'History - camelAI' },
    { name: 'description', content: 'Chat history' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'renameThread') {
    const threadId = formData.get('threadId') as string;
    const workspaceId = formData.get('workspaceId') as string;
    const title = formData.get('title') as string;

    if (!threadId || !workspaceId || !title) {
      return { error: 'Missing required fields' };
    }

    try {
      await chatDO.updateThread(context, threadId, title, workspaceId);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to rename thread' };
    }
  }

  if (intent === 'deleteThread') {
    const threadId = formData.get('threadId') as string;
    const workspaceId = formData.get('workspaceId') as string;

    if (!threadId || !workspaceId) {
      return { error: 'Missing required fields' };
    }

    try {
      await chatDO.deleteThread(context, threadId, workspaceId);
      await removeDeletedThreadFromOrgGroups(context, authContext.currentOrg.id, threadId);
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete thread' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const authEnv = getAuthEnv(getEnv(context));

  const url = new URL(request.url);
  const scope = getHistoryScope(url.searchParams);
  const createdBy = getHistoryCreatedBy(url.searchParams);
  const workspaceId = authContext.currentWorkspace?.id;

  if (!workspaceId) {
    return {
      threads: [],
      total: 0,
      offset: 0,
      limit: PAGE_SIZE,
      hasWorkspace: false,
      threadCreators: [],
      currentUserId: authContext.user.id,
      queryKey: buildHistoryQueryKey(scope, authContext.currentOrg.id, createdBy),
    };
  }

  const accessibleWorkspaceIds = authContext.workspaces.map((w) => w.id);
  const [page, rawCreators] = await Promise.all([
    fetchHistoryThreadsPage(context, {
      scope,
      workspaceId,
      accessibleWorkspaceIds,
      offset: 0,
      limit: PAGE_SIZE,
      createdBy,
    }),
    fetchHistoryThreadCreators(context, scope, workspaceId, accessibleWorkspaceIds),
  ]);
  const { threads, userMap } = await hydrateHistoryThreads(
    authEnv,
    page.items,
    rawCreators.map((creator) => creator.created_by)
  );
  const threadCreators = hydrateHistoryThreadCreators(rawCreators, userMap);
  const scopeId = scope === 'all-workspaces' ? authContext.currentOrg.id : workspaceId;

  return {
    threads,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    hasWorkspace: true,
    threadCreators,
    currentUserId: authContext.user.id,
    queryKey: buildHistoryQueryKey(scope, scopeId, createdBy),
  };
}

export default function HistoryPage() {
  const {
    threads,
    total,
    offset,
    limit,
    hasWorkspace,
    threadCreators,
    currentUserId,
    queryKey,
  } =
    useLoaderData<typeof loader>();

  if (!hasWorkspace) {
    return <NoWorkspacesError />;
  }

  return (
    <HistoryClient
      initialThreads={threads}
      initialTotal={total}
      initialOffset={offset}
      initialLimit={limit}
      threadCreators={threadCreators}
      currentUserId={currentUserId}
      initialQueryKey={queryKey}
    />
  );
}

export function HydrateFallback() {
  return <HistoryLoadingSkeleton />;
}
