import type { Route } from './+types/auth.logout';
import { getEnv } from '@/lib/cloudflare.server';
import { getSessionId, deleteSessionCookie } from '@/lib/cookies.server';
import { destroySession as destroySessionKV } from '../../../workers/main/src/session-kv';

interface AuthEnv {
  SESSIONS: KVNamespace;
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  try {
    const sessionId = getSessionId(request);
    if (sessionId) {
      const env = getEnv(context) as AuthEnv;
      await destroySessionKV(env.SESSIONS, sessionId);
    }

    const headers = new Headers();
    headers.append('Set-Cookie', deleteSessionCookie());

    return Response.json({ success: true }, { headers });
  } catch (error) {
    console.error('Logout error:', error);
    // Still clear the cookie even if session destruction fails
    const headers = new Headers();
    headers.append('Set-Cookie', deleteSessionCookie());
    return Response.json({ success: true }, { headers });
  }
}
