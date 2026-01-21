import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.history';
import { requireAuthContext } from '@/lib/auth.server';
import * as chatDO from '@/lib/chat-do.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { getUserById, type AuthEnv } from '@/lib/auth-do';
import HistoryClient from '@/components/pages/history/history-client';
import type { User } from '@/types';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
}

const PAGE_SIZE = 50;

export function meta() {
  return [
    { title: 'History - Chiridion' },
    { name: 'description', content: 'Chat history' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const workspaceId = authContext.currentWorkspace?.id;

  if (!workspaceId) {
    return {
      threads: [],
      total: 0,
      offset: 0,
      limit: PAGE_SIZE,
      orgId: authContext.currentOrg.id,
    };
  }

  const page = await chatDO.getThreadsPaginated(context, workspaceId, {
    offset: 0,
    limit: PAGE_SIZE,
  });

  // Hydrate threads with creator info
  const creatorIds = Array.from(
    new Set(page.items.map((t) => t.created_by).filter(Boolean))
  );
  const creatorProfiles = await Promise.all(
    creatorIds.map(async (id) => {
      const profile = await getUserById(authEnv, id);
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
            avatar: {
              color: creator.avatar_color,
              content: creator.avatar_content,
            },
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
  };
}

export default function HistoryPage() {
  const { threads, total, offset, limit, orgId } =
    useLoaderData<typeof loader>();

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
