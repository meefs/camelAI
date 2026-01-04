import { NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { id } = await params;
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const thread = await chatDO.getThread(id, session.org_id);
    if (!thread) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json(thread);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
