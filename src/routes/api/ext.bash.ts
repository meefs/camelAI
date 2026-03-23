import type { Route } from './+types/ext.bash';
import { getEnv } from '@/lib/cloudflare.server';
import { requireBearerAuth, getContainer, err } from '@/lib/ext-api.server';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const env = getEnv(context);
  const auth = await requireBearerAuth(request, env);
  if (auth instanceof Response) return auth;

  const body = await request.json() as { command: string; cwd?: string };
  if (!body.command) return err('command is required');

  const container = getContainer(env, auth);
  return Response.json(await container.exec(body.command, { cwd: body.cwd }));
}
