import type { Route } from './+types/auth.logout';
import { getEnv } from '@/lib/cloudflare.server';
import { getSessionIdFromRequest, createDeleteSessionCookieHeader } from '@/lib/cookies.server';
import { destroySession as destroySessionKV } from '../../../workers/main/src/session-kv';

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const sessionId = getSessionIdFromRequest(request);
    if (sessionId) {
      const env = getEnv(context);
      await destroySessionKV(env.SESSIONS, sessionId);
    }

    return Response.json(
      { success: true },
      { headers: { 'Set-Cookie': createDeleteSessionCookieHeader(request) } }
    );
  } catch (error) {
    console.error('Logout error:', error);
    return Response.json(
      { success: true },
      { headers: { 'Set-Cookie': createDeleteSessionCookieHeader(request) } }
    );
  }
}
