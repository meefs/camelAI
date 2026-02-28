import type { Route } from './+types/orgs.$id.update-slug';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';

function normalizeSlug(value: string): string {
  return value.trim().toLowerCase();
}

function isAdminForOrg(
  orgId: string,
  memberships: Array<{ org_id: string; role: string }>
): boolean {
  return memberships.some(
    (membership) =>
      membership.org_id === orgId &&
      (membership.role === 'owner' || membership.role === 'admin')
  );
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== 'POST') {
    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  }

  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = params.id;

  if (!orgId || authContext.currentOrg.id !== orgId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const isAdmin = isAdminForOrg(orgId, authContext.orgs);
  if (!isAdmin) {
    return Response.json({ error: 'Only organization admins can update the org slug' }, { status: 403 });
  }

  let body: { slug?: string };
  try {
    body = (await request.json()) as { slug?: string };
  } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const normalizedSlug = normalizeSlug(body.slug ?? '');
  if (!normalizedSlug) {
    return Response.json({ error: 'Slug is required' }, { status: 400 });
  }

  const orgStub = authEnv.ORG.get(
    authEnv.ORG.idFromName(orgId)
  );

  try {
    const updated = await orgStub.updateSlug(normalizedSlug, authContext.user.id);
    return Response.json({
      success: true,
      slug: updated.slug,
      org: updated,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update slug';
    if (message === 'invalid_slug_format') {
      return Response.json({ error: 'Invalid slug format' }, { status: 400 });
    }
    if (message === 'not_owner') {
      // Backward-compatible mapping while OrgDO still reports the old error code.
      return Response.json({ error: 'Only organization admins can update the org slug' }, { status: 403 });
    }
    if (message === 'slug_taken' || message === 'slug_already_finalized') {
      return Response.json({ error: message }, { status: 409 });
    }
    if (message === 'org_not_found') {
      return Response.json({ error: 'Organization not found' }, { status: 404 });
    }
    console.error('Failed to update slug:', error);
    return Response.json({ error: 'Failed to update slug' }, { status: 500 });
  }
}
