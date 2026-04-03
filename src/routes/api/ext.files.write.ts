import type { Route } from './+types/ext.files.write';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth, getContainer, err } from '@/lib/ext-api.server';
import { blockBetaFileEdit } from './workspaces.utils';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'PUT') return new Response('Method Not Allowed', { status: 405 });
  const env = getEnv(context);
  const authResult = await requireBearerAuth(request, env);
  if (authResult instanceof Response) return authResult;

  // Beta: file editing disabled. Remove this line to re-enable.
  return blockBetaFileEdit();

  const body = await request.json() as { path: string; content: string };
  if (!body.path || body.content === undefined) return err('path and content are required');

  const container = getContainer(env, authResult);
  return Response.json(await container.writeFile(body.path, body.content));
}
