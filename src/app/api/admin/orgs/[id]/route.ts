import { NextRequest, NextResponse } from 'next/server';
import { requireSuperuser } from '@/lib/admin-auth';
import * as authDO from '@/lib/auth-do';

export const dynamic = 'force-dynamic';

// GET /api/admin/orgs/[id] - Get org details with members
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const { id } = await params;
  const org = await authDO.getOrg(id);
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  const members = await authDO.getOrgMembers(id);
  const invitations = await authDO.getOrgInvitations(id);
  const integrations = await authDO.getOrgIntegrations(id);

  return NextResponse.json({ org, members, invitations, integrations });
}

// PUT /api/admin/orgs/[id] - Update org
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireSuperuser();
  if (!auth.authorized) return auth.response;

  const { id } = await params;
  const body = await request.json() as { name?: string };

  if (body.name !== undefined) {
    await authDO.updateOrgName(id, body.name);
  }

  const org = await authDO.getOrg(id);
  if (!org) {
    return NextResponse.json({ error: 'Organization not found' }, { status: 404 });
  }

  return NextResponse.json({ org });
}
