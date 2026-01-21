import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.apps';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { listWorkerScripts, getUserById, type AuthEnv } from '@/lib/auth-do';
import AppsClient from '@/components/pages/apps/apps-client';
import type { WorkerScriptWithCreator } from '@/types';

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

export function meta() {
  return [
    { title: 'Apps - Chiridion' },
    { name: 'description', content: 'Your deployed applications' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const hostname = request.headers.get('host')?.split(':')[0] ?? 'chiridion.ai';
  const renderedAt = Date.now();

  // Get apps for the current org/workspace
  const workspaceId = authContext.currentWorkspace?.id;
  let apps: WorkerScriptWithCreator[] = [];

  if (workspaceId) {
    const scripts = await listWorkerScripts(authEnv, authContext.currentOrg.id);

    // Filter to current workspace and hydrate with creator info
    const filteredScripts = scripts.filter(
      (script) => script.workspace_id === workspaceId
    );

    // Get creator profiles
    const creatorIds = Array.from(
      new Set(filteredScripts.map((s) => s.created_by).filter(Boolean))
    );
    const creatorProfiles = await Promise.all(
      creatorIds.map(async (id) => {
        const profile = await getUserById(authEnv, id);
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
        creator: creator
          ? {
              id: creator.id,
              name: creator.name,
              email: creator.email,
              avatar: {
                color: creator.avatar_color,
                content: creator.avatar_content,
              },
            }
          : undefined,
      };
    });
  }

  return {
    apps,
    orgId: authContext.currentOrg.id,
    hostname,
    renderedAt,
  };
}

export default function AppsPage() {
  const { apps, orgId, hostname, renderedAt } = useLoaderData<typeof loader>();

  return (
    <AppsClient
      initialApps={apps}
      orgId={orgId}
      hostname={hostname}
      initialNow={renderedAt}
    />
  );
}
