import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: NextRequest, { params }: RouteContext) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const { id } = await params;
    const project = await chatDO.getProject(id, session.org_id);
    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (e) {
    const message = String(e);
    if (message.includes('Project has threads')) {
      return NextResponse.json({ error: 'Project has threads' }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
