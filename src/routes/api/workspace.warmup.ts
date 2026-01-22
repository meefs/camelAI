import type { Route } from './+types/workspace.warmup';
import { getSession } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { warmupWorkspace as warmupWorkspaceAction, type AuthEnv } from '@/lib/auth-do';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const session = await getSession(request, context);
  if (!session) {
    return Response.json({ status: 'unauthorized' });
  }

  try {
    const body = await request.json() as { workspaceId?: string };
    const { workspaceId } = body;
    if (!workspaceId || typeof workspaceId !== 'string') {
      return Response.json({ error: 'workspaceId is required' }, { status: 400 });
    }

    const env = getEnv(context);
    const authEnv = getAuthEnv(env);
    const result = await warmupWorkspaceAction(authEnv, workspaceId, session.session.user_id);
    return Response.json({ status: result.status });
  } catch (error) {
    console.error('[warmup] Error:', error);
    return Response.json({ status: 'error' }, { status: 500 });
  }
}
