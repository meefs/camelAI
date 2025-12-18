import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

interface Params {
  params: {
    id: string;
  };
}

export async function GET(_request: NextRequest, { params }: Params) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const project = await chatDO.getProject(params.id, session.org_id);
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

export async function PUT(request: NextRequest, { params }: Params) {
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
    if (!body.name) {
      return NextResponse.json({ error: 'Missing name' }, { status: 400 });
    }

    const project = await chatDO.updateProject(params.id, body.name, session.org_id);
    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    return NextResponse.json(project);
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: Params) {
  try {
    const sessionId = await getSessionId();
    if (!sessionId) {
      return unauthorizedResponse();
    }

    const session = await authDO.getSession(sessionId);
    if (!session) {
      return unauthorizedResponse();
    }

    const project = await chatDO.getProject(params.id, session.org_id);
    if (!project) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    await chatDO.deleteProject(params.id, session.org_id);
    if (project.created_by && project.created_by !== 'system') {
      await authDO.removeUserProject(project.created_by, session.org_id, project.id);
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
