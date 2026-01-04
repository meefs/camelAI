import { NextRequest, NextResponse } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/users/[id] - Get user details
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const { id } = await params;
  const user = await authDO.getUserById(id);
  if (!user) {
    return NextResponse.json({ error: 'User not found' }, { status: 404 });
  }

  const orgs = await authDO.getUserOrgs(id);

  return NextResponse.json({ user, orgs });
}
