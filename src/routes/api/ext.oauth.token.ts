import type { Route } from './+types/ext.oauth.token';
import { getEnv } from '@/lib/cloudflare.server';
import { getOAuth, err, OAuthError } from '@/lib/ext-api.server';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });
  const env = getEnv(context);
  const oauth = getOAuth(env);
  if (!oauth) return err('External API not configured', 503);

  const params = new URLSearchParams(await request.text());
  const clientId = params.get('client_id');
  if (!clientId) return new OAuthError('invalid_request', 'client_id is required').toResponse();
  if (!oauth.validateClient(clientId)) return new OAuthError('invalid_client', 'Unknown client_id').toResponse(401);

  try {
    const gt = params.get('grant_type');
    if (gt === 'authorization_code') {
      const code = params.get('code');
      if (!code) return new OAuthError('invalid_request', 'code is required').toResponse();
      return Response.json(await oauth.exchangeAuthorizationCode(clientId, code, params.get('code_verifier') ?? undefined, params.get('redirect_uri') ?? undefined), { headers: { 'cache-control': 'no-store' } });
    }
    if (gt === 'refresh_token') {
      const rt = params.get('refresh_token');
      if (!rt) return new OAuthError('invalid_request', 'refresh_token is required').toResponse();
      return Response.json(await oauth.exchangeRefreshToken(clientId, rt), { headers: { 'cache-control': 'no-store' } });
    }
    return new OAuthError('unsupported_grant_type', `Unsupported: ${gt}`).toResponse();
  } catch (e) {
    if (e instanceof OAuthError) return e.toResponse();
    return Response.json({ error: 'Token exchange failed' }, { status: 500 });
  }
}
