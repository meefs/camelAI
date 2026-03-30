import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.apps';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import {
  setWorkerScriptPublic,
  deleteWorkerScript,
  getWorkerScript,
  getOrgCustomDomain,
} from '@/lib/auth-do';
import { deleteDispatchScript } from '../../workers/main/src/cf-api-proxy';
import * as chatDO from '@/lib/chat-do.server';
import { refreshWorkerScriptCustomDomainStates } from '@/lib/custom-domain.server';
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
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
  };
}

export function meta() {
  return [
    { title: 'Apps - camelAI' },
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
            await chatDO.setThreadPreviewAppVisibility(context, threadId, scriptName, isPublic);
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

    const accountId = env.CF_ACCOUNT_ID;
    const dispatchNamespace = env.CF_DISPATCH_NAMESPACE;
    const apiToken = env.CF_API_TOKEN;

    if (!accountId || !dispatchNamespace || !apiToken) {
      console.error('[deleteApp] Missing Cloudflare credentials', {
        hasAccountId: !!accountId,
        hasDispatchNamespace: !!dispatchNamespace,
        hasApiToken: !!apiToken,
      });
      return { error: 'Server configuration error: Missing Cloudflare credentials' };
    }

    try {
      // First, verify the script belongs to the current org (without deleting)
      const script = await getWorkerScript(
        authEnv,
        authContext.currentOrg.id,
        scriptName
      );

      if (!script) {
        console.warn('[deleteApp] Script not found in org database', {
          scriptName,
          orgId: authContext.currentOrg.id,
        });
        return { error: 'App not found or you do not have permission to delete it' };
      }

      // Delete from Cloudflare first - if this fails, user can retry
      const cfDeleteSuccess = await deleteDispatchScript(
        accountId,
        dispatchNamespace,
        scriptName,
        apiToken
      );

      if (!cfDeleteSuccess) {
        console.error('[deleteApp] Failed to delete from Cloudflare', {
          scriptName,
          orgId: authContext.currentOrg.id,
        });
        return { error: 'Failed to delete app from Cloudflare. Please try again.' };
      }

      // Finally, delete from database and KV index
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

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const hostname = request.headers.get('host')?.split(':')[0] ?? 'camelai.dev';
  const renderedAt = Date.now();

  // Check filter from URL params
  const url = new URL(request.url);
  const filter = url.searchParams.get('filter') || 'this-workspace';

  // Get apps for the current org/workspace
  const workspaceId = authContext.currentWorkspace?.id;
  let apps: WorkerScriptWithCreator[] = [];

  const [scripts, orgCustomDomainRecord] = await Promise.all([
    authEnv.ORG.get(authEnv.ORG.idFromName(authContext.currentOrg.id)).listWorkerScripts(),
    getOrgCustomDomain(authEnv, authContext.currentOrg.id),
  ]);
  const orgCustomDomain = orgCustomDomainRecord?.domain ?? null;
  const refreshedScripts = await refreshWorkerScriptCustomDomainStates(
    env,
    authContext.currentOrg.id,
    scripts,
    orgCustomDomain
  );

  // Filter based on filter param
  const filteredScripts = filter === 'all-workspaces'
    ? refreshedScripts
    : workspaceId
      ? refreshedScripts.filter((script) => script.workspace_id === workspaceId)
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
      custom_domain_hostname: script.custom_domain_hostname,
      custom_domain_cf_hostname_id: script.custom_domain_cf_hostname_id,
      custom_domain_status: script.custom_domain_status,
      custom_domain_ssl_status: script.custom_domain_ssl_status,
      custom_domain_error: script.custom_domain_error,
      custom_domain_updated_at: script.custom_domain_updated_at,
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
    orgSlug: authContext.currentOrg.slug,
    hostname,
    renderedAt,
    hasWorkspace: Boolean(workspaceId),
    orgCustomDomain,
  };
}

export default function AppsPage() {
  const { apps, orgId, orgSlug, hostname, renderedAt, hasWorkspace, orgCustomDomain } = useLoaderData<typeof loader>();

  if (!hasWorkspace) {
    return <NoWorkspacesError />;
  }

  return (
    <AppsClient
      initialApps={apps}
      orgId={orgId}
      orgSlug={orgSlug}
      hostname={hostname}
      initialNow={renderedAt}
      orgCustomDomain={orgCustomDomain}
    />
  );
}

export function HydrateFallback() {
  return <AppsLoadingSkeleton />;
}
