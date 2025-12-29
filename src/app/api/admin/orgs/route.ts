import { NextResponse } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/orgs - Get all organizations
export async function GET() {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const orgs = await authDO.adminGetAllOrgs();
  return NextResponse.json({ orgs });
}
