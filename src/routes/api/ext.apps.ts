import type { Route } from './+types/ext.apps';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth, getVanityDomain, err } from '@/lib/ext-api.server';

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const auth = await requireBearerAuth(request, env);
  if (auth instanceof Response) return auth;

  const orgStub = (env as any).ORG.get((env as any).ORG.idFromName(auth.org_id));
  const scripts = await orgStub.listWorkerScriptsByWorkspace(auth.workspace_id);
  const vd = getVanityDomain(env);

  const apps = await Promise.all(scripts.map(async (s: any) => {
    let url: string;
    try {
      const cd = await orgStub.getCustomDomain();
      if (cd?.domain) { url = `https://${s.script_name}.${cd.domain}`; }
      else {
        const slug = await orgStub.getSlug();
        const sep = slug && /^[a-z0-9]{6,}$/.test(slug) ? '-' : '--';
        url = slug ? `https://${s.script_name}${sep}${slug}.${vd}` : `https://${s.script_name}.${vd}`;
      }
    } catch { url = `https://${s.script_name}.${vd}`; }
    return { name: s.script_name, url, is_public: s.is_public, created_at: new Date(s.created_at).toISOString(), updated_at: new Date(s.updated_at).toISOString() };
  }));

  return Response.json({ count: apps.length, apps });
}
