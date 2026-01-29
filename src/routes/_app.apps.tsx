import { waitUntil } from 'cloudflare:workers';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.apps';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import {
  setWorkerScriptPublic,
  deleteWorkerScript,
} from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do.server';
import { getWorkspaceContainer, type WorkspaceContainerEnv } from '../../workers/main/src/workspace-container';
import { getAppUrl } from '@/lib/app-url';
import AppsClient from '@/components/pages/apps/apps-client';
import { AppsLoadingSkeleton } from '@/components/pages/apps/apps-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { WorkerScriptWithCreator } from '@/types';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
  };
}

export function meta() {
  return [
    { title: 'Apps - Chiridion' },
    { name: 'description', content: 'Your deployed applications' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'setAppPublic') {
    const scriptName = formData.get('scriptName') as string;
    const isPublic = formData.get('isPublic') === 'true';
    const threadId = formData.get('threadId') as string | null;

    if (!scriptName) {
      return { error: 'Script name is required' };
    }

    try {
      await setWorkerScriptPublic(
        authEnv,
        authContext.currentOrg.id,
        scriptName,
        isPublic,
        authContext.user.id
      );

      if (threadId && authContext.currentWorkspace?.id) {
        try {
          const thread = await chatDO.getThread(context, threadId, authContext.currentWorkspace.id);
          if (thread) {
            await chatDO.setThreadPreviewVisibility(context, threadId, isPublic);
          }
        } catch (err) {
          console.error('Failed to update preview visibility:', err);
        }
      }

      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to update app' };
    }
  }

  if (intent === 'deleteApp') {
    const scriptName = formData.get('scriptName') as string;

    if (!scriptName) {
      return { error: 'Script name is required' };
    }

    try {
      await deleteWorkerScript(
        authEnv,
        authContext.currentOrg.id,
        scriptName,
        authContext.user.id
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete app' };
    }
  }

  if (intent === 'startChatForApp') {
    const appName = formData.get('appName') as string;
    const workspaceId = formData.get('workspaceId') as string;
    const hostname = formData.get('hostname') as string | null;
    const configPath = formData.get('configPath') as string | null;
    const requestId = formData.get('requestId') as string | null;
    const isPublic = formData.get('isPublic') === 'true';

    if (!appName || !workspaceId) {
      return { error: 'appName and workspaceId are required', requestId };
    }

    // Verify the app is in the current workspace
    if (workspaceId !== authContext.currentWorkspace?.id) {
      return { error: 'App is in a different workspace. Please switch workspaces first.', requestId };
    }

    try {
      // 1. Create the thread
      const thread = await chatDO.createThread(
        context,
        workspaceId,
        `Chat about ${appName}`,
        authContext.user?.id
      );

      // 2. Set the app as a preview worker
      await chatDO.setThreadPreview(context, thread.id, [appName], isPublic);

      // 3. Seed the thread with a system message for the agent
      const appUrl = getAppUrl(appName, hostname ?? undefined);
      const sourceInfo = configPath ? ` The app's wrangler config is at "${configPath}".` : '';
      const seedMessage = `<chiridion system message>The user is currently previewing the app "${appName}" at ${appUrl}.${sourceInfo} They clicked on this app from the Apps page to start a conversation about it.</chiridion system message>`;

      // Write the JSONL file with the seeded message
      const containerEnv = env as unknown as WorkspaceContainerEnv;
      const container = getWorkspaceContainer(containerEnv, workspaceId);

      // Get workspace info for org_id
      const wsStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
      const wsInfo = await wsStub.getInfo();
      if (!wsInfo) {
        return { error: 'Workspace not found', requestId };
      }

      // Ensure container is running
      await container.startForWorkspace(workspaceId, wsInfo.org_id);

      // Create the JSONL entry
      const uuid = crypto.randomUUID();
      const timestamp = new Date().toISOString();
      const jsonlEntry = {
        parentUuid: null,
        isSidechain: false,
        userType: 'external',
        cwd: '/home/claude',
        sessionId: thread.id,
        type: 'user',
        message: {
          role: 'user',
          content: seedMessage,
        },
        isMeta: true,
        uuid,
        timestamp,
      };

      // Write the JSONL file
      const jsonlPath = `/home/claude/.claude/projects/-home-claude/${thread.id}.jsonl`;

      // Ensure the directory exists and write the seed message
      await container.exec(`mkdir -p /home/claude/.claude/projects/-home-claude`);
      const jsonlContent = JSON.stringify(jsonlEntry);
      await container.writeFile(jsonlPath, jsonlContent + '\n');

      // Generate title in background
      waitUntil(
        chatDO.generateThreadTitle(
          context,
          thread.id,
          workspaceId,
          `Chat about ${appName}`
        )
      );

      return { success: true, thread, appUrl, requestId };
    } catch (err) {
      console.error('Failed to create thread for app:', err);
      return { error: err instanceof Error ? err.message : 'Failed to create thread', requestId };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const hostname = request.headers.get('host')?.split(':')[0] ?? 'chiridion.ai';
  const renderedAt = Date.now();

  // Check filter from URL params
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';

  // Get apps for the current org/workspace
  const workspaceId = authContext.currentWorkspace?.id;
  let apps: WorkerScriptWithCreator[] = [];

  const scripts = await authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id)).listWorkerScripts();

  // Filter based on filter param
  const filteredScripts = filter === 'all-workspaces'
    ? scripts
    : workspaceId
      ? scripts.filter((script) => script.workspace_id === workspaceId)
      : [];

  // Get creator profiles
  const creatorIds = Array.from(
    new Set(filteredScripts.map((s) => s.created_by).filter(Boolean))
  );
  const creatorProfiles = await Promise.all(
    creatorIds.map(async (id) => {
      const profile = await authEnv.USER.get(authEnv.USER.idFromName(id)).getProfile();
      return [id, profile] as const;
    })
  );
  const creatorMap = new Map(creatorProfiles.filter(([, p]) => p !== null));

  apps = filteredScripts.map((script) => {
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

  return {
    apps,
    orgId: authContext.currentOrg.id,
    hostname,
    renderedAt,
    hasWorkspace: Boolean(workspaceId),
  };
}

export default function AppsPage() {
  const { apps, orgId, hostname, renderedAt, hasWorkspace } = useLoaderData<typeof loader>();

  if (!hasWorkspace) {
    return <NoWorkspacesError />;
  }

  return (
    <AppsClient
      initialApps={apps}
      orgId={orgId}
      hostname={hostname}
      initialNow={renderedAt}
    />
  );
}

export function HydrateFallback() {
  return <AppsLoadingSkeleton />;
}
