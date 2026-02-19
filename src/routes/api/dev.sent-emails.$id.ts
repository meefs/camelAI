import type { Route } from './+types/dev.sent-emails.$id';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  getDevEmailOutboxEntryById,
  isDevEmailOutboxEnabled,
} from '@/lib/dev-email-outbox';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const env = getEnv(context);
  if (!isDevEmailOutboxEnabled(env)) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  let authContext: Awaited<ReturnType<typeof requireAuthContext>>;
  try {
    authContext = await requireAuthContext(request, context);
  } catch (error) {
    if (error instanceof Response && error.status >= 300 && error.status < 400) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    throw error;
  }

  if (!authContext.user.is_superuser) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const id = params.id?.trim();
  if (!id) {
    return Response.json({ error: 'Missing email id' }, { status: 400 });
  }

  const entry = await getDevEmailOutboxEntryById(env, id);
  if (!entry) {
    return Response.json({ error: 'Email not found' }, { status: 404 });
  }

  const url = new URL(request.url);
  if (url.searchParams.get('format') === 'html') {
    return new Response(entry.htmlBody, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  }

  return Response.json(entry, {
    headers: {
      'Cache-Control': 'no-store',
    },
  });
}
