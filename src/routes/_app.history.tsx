import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.history';
import { requireAuthContext } from '@/lib/auth.server';
import * as chatDO from '@/lib/chat-do.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import HistoryClient from '@/components/pages/history/history-client';
import { HistoryLoadingSkeleton } from '@/components/history/history-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { User } from '@/types';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,

  };
}

const PAGE_SIZE = 50;

export function meta() {
  return [
    { title: 'History - camelAI' },
    { name: 'description', content: 'Chat history' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  await requireAuthContext(request, context);

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
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete thread' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';
  const workspaceId = authContext.currentWorkspace?.id;

  if (!workspaceId) {
    return {
      threads: [],
      total: 0,
      offset: 0,
      limit: PAGE_SIZE,
      orgId: authContext.currentOrg.id,
      hasWorkspace: false,
    };
  }

  // Get accessible workspace IDs for all-workspaces filter
  const accessibleWorkspaceIds = authContext.workspaces.map((w) => w.id);

  const page = filter === 'all-workspaces'
    ? await chatDO.getThreadsPaginatedAllWorkspaces(context, accessibleWorkspaceIds, {
        offset: 0,
        limit: PAGE_SIZE,
      })
    : await chatDO.getThreadsPaginated(context, workspaceId, {
        offset: 0,
        limit: PAGE_SIZE,
      });

  // Hydrate threads with creator info
  const creatorIds = Array.from(
    new Set(page.items.map((t) => t.created_by).filter(Boolean))
  );
  const creatorProfiles = await Promise.all(
    creatorIds.map(async (id) => {
      const profile = await authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile();
      return [id, profile] as const;
    })
  );
  const creatorMap = new Map(creatorProfiles.filter(([, p]) => p !== null));

  const threads = page.items.map((thread) => {
    const creator = creatorMap.get(thread.created_by);
    return {
      ...thread,
      creator: creator
        ? ({
            id: creator.id,
            email: creator.email,
            name: creator.name,
            created_at: creator.created_at,
            is_superuser: creator.is_superuser,
            avatar: creator.avatar,
            is_orphaned: creator.is_orphaned,
          } as User)
        : undefined,
    };
  });

  return {
    threads,
    total: page.total,
    offset: page.offset,
    limit: page.limit,
    orgId: authContext.currentOrg.id,
    hasWorkspace: true,
  };
}

export default function HistoryPage() {
  const { threads, total, offset, limit, orgId, hasWorkspace } =
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
      initialOrgId={orgId}
    />
  );
}

export function HydrateFallback() {
  return <HistoryLoadingSkeleton />;
}
