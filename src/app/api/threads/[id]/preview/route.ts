import { NextRequest, NextResponse } from 'next/server';
import * as chatDO from '@/lib/chat-do';
import * as authDO from '@/lib/auth-do';
import { getSessionId, unauthorizedResponse } from '@/lib/auth';

interface RouteContext {
  params: Promise<{ id: string }>;
}

// GET /api/threads/[id]/preview - Get current preview workers (script names)
// Returns array of script names like ["myworker"]
// Frontend constructs full URL: https://{scriptName}.chiridion.ai
export async function GET(_request: NextRequest, { params }: RouteContext) {
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

    const workspaceId = session.workspace_id;
    if (!workspaceId) {
      return NextResponse.json({ error: 'No workspace selected' }, { status: 400 });
    }
    const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
    if (access === 'none') {
      return NextResponse.json({ error: 'Workspace not found' }, { status: 404 });
    }

    // Verify thread belongs to user's workspace (prevents cross-tenant leak)
    const thread = await chatDO.getThread(id, workspaceId);
    if (!thread) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const workers = await chatDO.getThreadPreview(id);
    return NextResponse.json({ workers });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}

// POST is handled by the worker with deploy token auth (see workers/main/src/index.ts)
// This prevents unauthenticated access to setting previews
