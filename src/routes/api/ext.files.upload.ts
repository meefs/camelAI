import type { Route } from './+types/ext.files.upload';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth, getContainer, err } from '@/lib/ext-api.server';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const env = getEnv(context);
  const auth = await requireBearerAuth(request, env);
  if (auth instanceof Response) return auth;

  const body = await request.json() as { path: string; content_base64: string };
  if (!body.path || !body.content_base64) return err('path and content_base64 are required');

  const container = getContainer(env, auth);
  return Response.json(await container.writeBinaryFile(body.path, body.content_base64));
}
