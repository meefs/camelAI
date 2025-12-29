import { NextResponse } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/threads - Get all threads across all orgs
export async function GET() {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const threads = await authDO.adminGetAllThreads();
  return NextResponse.json({ threads });
}
