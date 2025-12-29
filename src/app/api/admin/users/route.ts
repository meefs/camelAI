import { NextResponse } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/users - Get all users (via overview)
export async function GET() {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const overview = await authDO.getAdminOverview();
  return NextResponse.json({ users: overview.users });
}
