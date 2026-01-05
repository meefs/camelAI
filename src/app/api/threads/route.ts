import { NextRequest } from 'next/server';
import * as authDO from '@/lib/auth-do';
import * as chatDO from '@/lib/chat-do';
import { errorResponse, getSessionId, jsonResponse, unauthorizedResponse } from '@/lib/auth';

function parseNumber(value: string | null, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  if (Number.isNaN(parsed) || parsed < 0) return fallback;
  return parsed;
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const offset = parseNumber(request.nextUrl.searchParams.get('offset'), 0);
    const limit = parseNumber(request.nextUrl.searchParams.get('limit'), 50);
    const page = await chatDO.getThreadsPaginated(session.org_id, { offset, limit });
    return jsonResponse(page);
  } catch (error) {
    console.error('Error listing threads:', error);
    return errorResponse('Failed to list threads', 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const body = await request.json() as { title?: string; session_id?: string };
    const title = typeof body.title === 'string' ? body.title : undefined;
    const sessionIdOverride = typeof body.session_id === 'string' ? body.session_id : undefined;
    const thread = await chatDO.createThread(
      session.org_id,
      title,
      session.user_id,
      sessionIdOverride
    );
    return jsonResponse(thread);
  } catch (error) {
    console.error('Error creating thread:', error);
    return errorResponse('Failed to create thread', 500);
  }
}
