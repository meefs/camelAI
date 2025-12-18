import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

export async function GET() {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const threads = await chatDO.getThreads(session.org_id);
    return NextResponse.json(threads);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
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

    const body = await request.json() as { title?: string; projectId?: string; projectName?: string };
    let projectId = body.projectId?.trim();
    if (!projectId) {
      const projectName = body.projectName?.trim() || body.title?.trim() || 'New Project';
      const project = await chatDO.createProject(session.org_id, projectName, session.user_id);
      await authDO.addUserProject(session.user_id, session.org_id, project.id);
      projectId = project.id;
    }
    const thread = await chatDO.createThread(session.org_id, body.title, projectId);
    return NextResponse.json(thread);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
