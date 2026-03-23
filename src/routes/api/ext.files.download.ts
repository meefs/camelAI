import type { Route } from './+types/ext.files.download';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth, getContainer, err } from '@/lib/ext-api.server';

export async function loader({ request, context }: Route.LoaderArgs) {
  const env = getEnv(context);
  const auth = await requireBearerAuth(request, env);
  if (auth instanceof Response) return auth;

  const path = new URL(request.url).searchParams.get('path');
  if (!path) return err('path query parameter is required');

  const container = getContainer(env, auth);
  const resp = await container.readFileStream(path);
  if (!resp) return err('File not found', 404);

  const filename = path.split('/').pop() ?? 'file';
  return new Response(resp.body, {
    headers: {
      'content-type': resp.headers.get('content-type') ?? 'application/octet-stream',
      'content-disposition': `attachment; filename="${filename}"`,
    },
  });
}
