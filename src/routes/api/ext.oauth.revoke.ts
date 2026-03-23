import type { Route } from './+types/ext.oauth.revoke';
import { getEnv } from '@/lib/cloudflare.server';
import { getOAuth, err, OAuthError } from '@/lib/ext-api.server';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const env = getEnv(context);
  const oauth = getOAuth(env);
  if (!oauth) return err('External API not configured', 503);

  const params = new URLSearchParams(await request.text());
  const token = params.get('token');
  if (!token) return new OAuthError('invalid_request', 'token is required').toResponse();
  await oauth.revokeToken(token, params.get('token_type_hint') ?? undefined);
  return new Response(null, { status: 200 });
}
