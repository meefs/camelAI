import type { Route } from './+types/admin.threads.$id.messages';
import { requireSuperuser } from '@/lib/auth.server';
import { ensureAdminIndexReady } from '@/lib/auth-do.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  loadAdminThreadMessagesResponse,
} from '../../../workers/main/src/routes/admin/helpers';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    await requireSuperuser(request, context);
    const env = getEnv(context);
    await ensureAdminIndexReady(env);
    return loadAdminThreadMessagesResponse(env, params.id ?? '');
  } catch (error) {
    if (error instanceof Response) {
      return error;
    }
    console.error('Error loading admin thread messages:', error);
    return Response.json({ error: 'Failed to load messages' }, { status: 500 });
  }
}
