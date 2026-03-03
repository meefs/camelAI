import { waitUntil } from 'cloudflare:workers';
import { useEffect, useRef } from 'react';
import { useLoaderData, useRevalidator } from 'react-router';
import type { Route } from './+types/_app.chat._index';
import { requireAuthContext, requireSessionWorkspaceAccess } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getAuthEnv, integrationRecordToIntegration } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';
import Chat from '@/components/Chat';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Integration, Thread, WorkerScriptWithCreator } from '@/types';
import { useAuthData } from '@/hooks/use-auth-data';

/**
 * Skip loader revalidation after createThread — the user is navigating away
 * immediately, so re-fetching the welcome screen data is wasted work.
 */
export function shouldRevalidate({
  formData,
  defaultShouldRevalidate,
}: {
  formData?: FormData;
  defaultShouldRevalidate: boolean;
}) {
  if (formData?.get('intent') === 'createThread') return false;
  return defaultShouldRevalidate;
}

export function meta() {
  return [
    { title: 'New Chat - camelAI' },
    { name: 'description', content: 'Start a new AI chat' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const hostname = request.headers.get('host')?.split(':')[0] || undefined;
  const workspaceId = authContext.currentWorkspace?.id;
  const userId = authContext.user?.id ?? null;
  const userName = authContext.user?.name ?? null;
  const renderedAt = Date.now();

  const allAppsPromise: Promise<WorkerScriptWithCreator[]> = workspaceId && authContext.currentOrg?.id
    ? (async () => {
        const scripts = await authEnv.ORG.get(
          authEnv.ORG.idFromName(authContext.currentOrg.id)
        ).listWorkerScripts();

        const filteredScripts = scripts
          .filter((script) => script.workspace_id === workspaceId)
          .sort((a, b) => b.updated_at - a.updated_at);

        const creatorIds = Array.from(
          new Set(filteredScripts.map((script) => script.created_by).filter(Boolean))
        );
        const creatorProfiles = await Promise.all(
          creatorIds.map(async (id) => {
            const profile = await authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile();
            return [id, profile] as const;
          })
        );
        const creatorMap = new Map(creatorProfiles.filter(([, profile]) => profile !== null));

        return filteredScripts.map((script) => {
          const creator = creatorMap.get(script.created_by);
          return {
            script_name: script.script_name,
            workspace_id: script.workspace_id,
            created_by: script.created_by,
            created_at: script.created_at,
            updated_at: script.updated_at,
            is_public: script.is_public,
            preview_key: script.preview_key,
            preview_updated_at: script.preview_updated_at,
            preview_status: script.preview_status,
            preview_error: script.preview_error,
            config_path: script.config_path,
            creator: creator
              ? {
                  id: creator.id,
                  name: creator.name,
                  email: creator.email,
                  avatar: creator.avatar,
                }
              : undefined,
          };
        });
      })().catch((error) => {
        console.error('Failed to load workspace apps:', error);
        return [];
      })
    : Promise.resolve([]);

  const recentThreadsPromise: Promise<Thread[]> = workspaceId
    ? chatDO.getRecentThreads(context, workspaceId, 20).catch((error) => {
        console.error('Failed to load recent threads:', error);
        return [];
      })
    : Promise.resolve([]);

  const connectionsPromise: Promise<Integration[]> = workspaceId
    ? env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId))
        .getIntegrations()
        .then((records) => records.map(integrationRecordToIntegration))
        .catch((error) => {
          console.error('Failed to load workspace connections:', error);
          return [];
        })
    : Promise.resolve([]);

  const [allApps, allRecentThreads, connections] = await Promise.all([
    allAppsPromise,
    recentThreadsPromise,
    connectionsPromise,
  ]);

  const recentThreads = userId
    ? allRecentThreads.filter((t) => t.created_by === userId).slice(0, 6)
    : allRecentThreads.slice(0, 6);

  return {
    workspaceId: workspaceId ?? null,
    hostname,
    userId,
    userName,
    allApps,
    connections,
    recentThreads,
    renderedAt,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  // Security-critical write path: validate current workspace membership/access
  // without loading full auth context.
  const { orgId, workspaceId, userId } = await requireSessionWorkspaceAccess(request, context, undefined, {
    requireWrite: true,
  });
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'createThread') {
    try {
      const firstMessage = formData.get('firstMessage') as string | null;
      const previewAppsRaw = formData.get('previewApps') as string | null;

      const thread = await chatDO.createThread(
        context,
        workspaceId,
        undefined, // title will be generated asynchronously
        userId,
        firstMessage || undefined
      );

      // Set preview apps if provided (for "chat with this app" flow)
      if (previewAppsRaw) {
        const previewApps = previewAppsRaw.split(',').filter(Boolean);
        if (previewApps.length > 0) {
          const scriptName = previewApps[0];
          const script = await getWorkerScript(authEnv, orgId, scriptName);
          await chatDO.setThreadPreviewTarget(context, thread.id, {
            kind: 'app',
            scriptName,
            isPublic: script?.is_public ?? false,
          });
        }
      }

      // Generate title in background if we have a first message
      if (firstMessage) {
        waitUntil(
          chatDO.generateThreadTitle(
            context,
            thread.id,
            workspaceId,
            firstMessage
          )
        );
      }

      return Response.json({ thread });
    } catch (error) {
      console.error('Failed to create thread:', error);
      return Response.json({ error: 'Failed to create thread' }, { status: 500 });
    }
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}

export default function NewChatPage() {
  const {
    workspaceId,
    hostname,
    userId,
    userName,
    allApps,
    connections,
    recentThreads,
    renderedAt,
  } = useLoaderData<typeof loader>();
  const { currentWorkspace } = useAuthData();
  const revalidator = useRevalidator();
  const prevWorkspaceRef = useRef(currentWorkspace?.id);

  useEffect(() => {
    const nextWorkspaceId = currentWorkspace?.id;
    if (nextWorkspaceId && nextWorkspaceId !== prevWorkspaceRef.current) {
      prevWorkspaceRef.current = nextWorkspaceId;
      revalidator.revalidate();
    }
  }, [currentWorkspace?.id, revalidator]);

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <Chat
      workspaceId={workspaceId}
      hostname={hostname}
      welcomeData={{
        userId,
        userName,
        allApps,
        connections,
        recentThreads,
        renderedAt,
      }}
    />
  );
}
