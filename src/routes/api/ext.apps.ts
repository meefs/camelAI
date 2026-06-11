import type { Route } from './+types/ext.apps';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth } from '@/lib/ext-api.server';
import { getPreferredAppUrl } from '@/lib/app-url';
import { getAppUrlContext } from '@/lib/app-url.server';
import { refreshWorkerScriptCustomDomainStates } from '@/lib/custom-domain.server';

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const auth = await requireBearerAuth(request, env);
  if (auth instanceof Response) return auth;

  const orgStub = (env as any).ORG.get((env as any).ORG.idFromName(auth.org_id));
  const hostname = getAppUrlContext(env, request);
  let scripts = await orgStub.listWorkerScriptsByWorkspace(auth.workspace_id);

  scripts = await refreshWorkerScriptCustomDomainStates(env as any, auth.org_id, scripts, null);
  const orgSlug = await orgStub.getSlug();

  const apps = await Promise.all(scripts.map(async (s: any) => {
    const url = getPreferredAppUrl(s, {
      hostname,
      orgSlug: orgSlug ?? undefined,
      orgCustomDomain: null,
    });
    return { name: s.script_name, url, is_public: s.is_public, created_at: new Date(s.created_at).toISOString(), updated_at: new Date(s.updated_at).toISOString() };
  }));

  return Response.json({ count: apps.length, apps });
}
