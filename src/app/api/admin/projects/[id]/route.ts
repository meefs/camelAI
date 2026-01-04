import { NextResponse, type NextRequest } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/projects/[id] - Get project details
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const { id } = await params;

  // Get all projects and find the one we want
  const allProjects = await authDO.adminGetAllProjects();
  const project = allProjects.find(p => p.id === id);

  if (!project) {
    return NextResponse.json({ error: 'Project not found' }, { status: 404 });
  }

  // Get threads for this project
  const allThreads = await authDO.adminGetAllThreads();
  const threads = allThreads.filter(t => t.project_id === id);

  return NextResponse.json({ project, threads });
}
