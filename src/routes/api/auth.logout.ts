import type { Route } from './+types/auth.logout';
import { getEnv } from '@/lib/cloudflare.server';
import { getSignedSessionFromRequest, createDeleteSessionCookieHeader } from '@/lib/cookies.server';
import {
  CLOUDFLARE_ACCESS_AUTH_SOURCE,
  getCloudflareAccessLogoutUrl,
  type CloudflareAccessEnv,
} from '@/lib/cloudflare-access-auth.server';
import type { UserDO } from '../../../workers/main/src/auth';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  let accessLogoutUrl: string | null = null;
  try {
    const env = getEnv(context);
    const session = await getSignedSessionFromRequest(request, env.TOKEN_SIGNING_SECRET);
    accessLogoutUrl =
      session?.auth_source === CLOUDFLARE_ACCESS_AUTH_SOURCE
        ? getCloudflareAccessLogoutUrl(request, env as unknown as CloudflareAccessEnv)
        : null;

    if (session) {
      // Invalidate all outstanding signed sessions for this user so that
      // copied/stolen tokens created before this logout become unusable.
      const userNs = env.USER as DurableObjectNamespace<UserDO>;
      const userStub = userNs.get(userNs.idFromName(session.user_id));
      await userStub.invalidateSessions();
    }
  } catch (error) {
    console.error('Logout session invalidation error:', error);
    // Continue with cookie deletion even if DO call fails
  }

  return Response.json(
    { success: true, accessLogoutUrl },
    { headers: { 'Set-Cookie': createDeleteSessionCookieHeader(request) } }
  );
}
