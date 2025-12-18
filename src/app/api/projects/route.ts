import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

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

    const url = new URL(request.url);
    const createdBy = url.searchParams.get('createdBy')?.trim();
    const projects = createdBy
      ? await chatDO.getProjectsByUser(session.org_id, createdBy)
      : await chatDO.getProjects(session.org_id);
    return NextResponse.json(projects);
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

    const body = await request.json() as { name?: string };
    const project = await chatDO.createProject(session.org_id, body.name, session.user_id);
    await authDO.addUserProject(session.user_id, session.org_id, project.id);
    return NextResponse.json(project);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
