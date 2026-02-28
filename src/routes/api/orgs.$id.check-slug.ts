import type { Route } from './+types/orgs.$id.check-slug';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,22}[a-z0-9]$/;

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
    return Response.json(
      { available: false, reason: 'not_admin' },
      { status: 403 }
    );
  }

  const isAdmin = isAdminForOrg(orgId, authContext.orgs);
  if (!isAdmin) {
    return Response.json(
      { available: false, reason: 'not_admin' },
      { status: 403 }
    );
  }

  let body: { slug?: string };
  try {
    body = (await request.json()) as { slug?: string };
  } catch {
    return Response.json(
      { available: false, reason: 'invalid_format' },
      { status: 400 }
    );
  }

  const normalizedSlug = normalizeSlug(body.slug ?? '');
  if (!SLUG_PATTERN.test(normalizedSlug)) {
    return Response.json(
      { available: false, reason: 'invalid_format' },
      { status: 200 }
    );
  }

  if (normalizedSlug === authContext.currentOrg.slug) {
    return Response.json({ available: true });
  }

  const slugStub = authEnv.ORG_SLUG.get(
    authEnv.ORG_SLUG.idFromName(normalizedSlug)
  );
  const owner = await slugStub.getOwner();

  if (owner && owner !== orgId) {
    return Response.json({ available: false, reason: 'taken' }, { status: 200 });
  }

  if (owner === orgId) {
    return Response.json({ available: true });
  }

  return Response.json({ available: true });
}
