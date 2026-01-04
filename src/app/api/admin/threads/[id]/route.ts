import { NextResponse } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/threads/[id] - Get thread with messages
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const { id } = await params;
  const result = await authDO.adminGetThreadWithMessages(id);
  if (!result) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  }

  return NextResponse.json(result);
}
