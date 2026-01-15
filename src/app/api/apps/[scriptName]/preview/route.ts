import { NextRequest } from 'next/server';
import { getCloudflareContext } from '@opennextjs/cloudflare';
import { errorResponse, forbiddenResponse, getSessionId, unauthorizedResponse } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';

interface RouteParams {
  params: Promise<{ scriptName: string }>;
}

interface R2Env {
  R2_BUCKET: R2Bucket;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { scriptName } = await params;
    const normalized = decodeURIComponent(scriptName ?? '').trim();
    if (!normalized) {
      return errorResponse('App not found', 404);
    }

    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const accessInfo = await authDO.getWorkerAccessInfo(normalized);
    if (!accessInfo) {
      return errorResponse('App not found', 404);
    }

    const isMember = await authDO.isOrgMember(session.user_id, accessInfo.org_id);
    if (!isMember) {
      return forbiddenResponse();
    }

    const script = await authDO.getWorkerScript(accessInfo.org_id, normalized);
    if (!script || script.preview_status !== 'ready' || !script.preview_key) {
      return errorResponse('Preview not available', 404);
    }

    const { env } = getCloudflareContext() as unknown as { env: R2Env };
    const object = await env.R2_BUCKET.get(script.preview_key);
    if (!object) {
      return errorResponse('Preview not available', 404);
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
    return errorResponse('Failed to load app preview', 500);
  }
}
