import type { Route } from './+types/ext.files';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth, getContainer } from '@/lib/ext-api.server';

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const auth = await requireBearerAuth(request, env);
  if (auth instanceof Response) return auth;

  const url = new URL(request.url);
  const path = url.searchParams.get('path') ?? '/home/claude';
  const recursive = url.searchParams.get('recursive') === '1';

  const container = getContainer(env, auth);
  return Response.json(await container.listFiles(path, { recursive }));
}
