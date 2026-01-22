import type { Route } from './+types/apps.$scriptName.preview';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import { getSession, isOrgMember, getWorkerAccessInfo, getWorkerScript } from '@/lib/auth-do';

const SESSION_COOKIE_NAME = 'chiridion_session';

function getCookieValue(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return rest.join('=') || '';
  }
  return null;
}

interface R2Env extends AuthEnv {
  R2_BUCKET: R2Bucket;
}

function getR2Env(env: CloudflareEnv): R2Env {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    API_TOKENS: env.API_TOKENS,
    R2_BUCKET: env.R2_BUCKET,
  };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const scriptName = params.scriptName;
    const normalized = decodeURIComponent(scriptName ?? '').trim();
    if (!normalized) {
      return Response.json({ error: 'App not found' }, { status: 404 });
    }

    const sessionId = getCookieValue(request.headers.get('Cookie'), SESSION_COOKIE_NAME);
    if (!sessionId) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const env = getR2Env(getEnv(context));
    const session = await getSession(env, sessionId);
    if (!session) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const accessInfo = await getWorkerAccessInfo(env, normalized);
    if (!accessInfo) {
      return Response.json({ error: 'App not found' }, { status: 404 });
    }

    const isMember = await isOrgMember(env, session.user_id, accessInfo.org_id);
    if (!isMember) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const script = await getWorkerScript(env, accessInfo.org_id, normalized);
    if (!script || script.preview_status !== 'ready' || !script.preview_key) {
      return Response.json({ error: 'Preview not available' }, { status: 404 });
    }

    const object = await env.R2_BUCKET.get(script.preview_key);
    if (!object) {
      return Response.json({ error: 'Preview not available' }, { status: 404 });
    }

    const etag = object.etag;
    if (etag && request.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'Cache-Control': object.httpMetadata?.cacheControl ?? 'public, max-age=300',
          ...(etag ? { ETag: etag } : {}),
        },
      });
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
        'Cache-Control': object.httpMetadata?.cacheControl ?? 'public, max-age=300',
        'Content-Length': object.size.toString(),
        ...(etag ? { ETag: etag } : {}),
      },
    });
  } catch (error) {
    console.error('Error loading app preview:', error);
    return Response.json({ error: 'Failed to load app preview' }, { status: 500 });
  }
}
