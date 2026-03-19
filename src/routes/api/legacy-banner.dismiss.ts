import type { Route } from './+types/legacy-banner.dismiss';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let authContext: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    authContext = await requireAuthContext(request, context);
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      return Response.json({ error: 'Not authenticated' }, { status: 401 });
    }
    throw error;
  }

  const env = getEnv(context);
  await env.APP_KV.put(`legacy_banner_dismissed:${authContext.user.id}`, '1');

  return Response.json({ success: true });
}
