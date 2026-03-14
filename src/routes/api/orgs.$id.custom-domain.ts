import type { Route } from './+types/orgs.$id.custom-domain';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { isOrgAdmin } from '@/lib/auth-do';
import {
  getOrgCustomDomain,
  setOrgCustomDomain,
  removeOrgCustomDomain,
  updateOrgCustomDomainStatus,
} from '@/lib/auth-do';
import {
  createCustomHostname,
  deleteCustomHostname,
  getCustomHostnameStatus,
} from '../../../workers/main/src/cf-api-proxy';

function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
  };
}

// GET - Return the org's custom domain (or null)
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = params.id;

  if (authContext.currentOrg.id !== orgId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const domain = await getOrgCustomDomain(authEnv, orgId);
  return Response.json({ domain });
}

// POST - set, remove, or checkStatus
export async function action({ request, params, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = params.id;

  if (authContext.currentOrg.id !== orgId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  // Require admin
  const admin = await isOrgAdmin(authEnv, authContext.user.id, orgId);
  if (!admin) {
    return Response.json({ error: 'Only admins can manage custom domains' }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = formData.get('intent') as string;

  if (intent === 'set') {
    const domain = (formData.get('domain') as string)?.trim().toLowerCase();
    if (!domain) {
      return Response.json({ error: 'Domain is required' }, { status: 400 });
    }

    // Basic domain validation (must be a valid base domain, e.g., apps.example.com)
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(domain)) {
      return Response.json({ error: 'Invalid domain format' }, { status: 400 });
    }

    // Reject our own domains
    if (domain.endsWith('.camelai.app') || domain.endsWith('.camelai.dev')) {
      return Response.json({ error: 'Cannot use camelAI domains as custom domains' }, { status: 400 });
    }

    const zoneId = env.CF_ZONE_ID;
    const apiToken = env.CF_API_TOKEN;

    if (!zoneId || !apiToken) {
      console.error('[custom-domains] Missing CF_ZONE_ID or CF_API_TOKEN');
      return Response.json({ error: 'Custom domains are not configured on this server' }, { status: 500 });
    }

    // Create new CF wildcard hostname first, then clean up old one
    const fallbackOrigin = env.CF_CUSTOM_HOSTNAME_FALLBACK;
    const cfHostname = await createCustomHostname(zoneId, apiToken, `*.${domain}`, fallbackOrigin);
    if (!cfHostname) {
      return Response.json({ error: 'Failed to create custom hostname with Cloudflare' }, { status: 502 });
    }
    const cfHostnameId = cfHostname.id;

    // Capture old hostname ID for cleanup after successful commit
    const existing = await getOrgCustomDomain(authEnv, orgId);
    const oldCfHostnameId = existing?.cf_hostname_id;

    try {
      const customDomain = await setOrgCustomDomain(
        authEnv, orgId, domain, authContext.user.id, cfHostnameId
      );

      // Clean up old CF hostname only after new domain is durably saved
      if (oldCfHostnameId && oldCfHostnameId !== cfHostnameId) {
        await deleteCustomHostname(zoneId, apiToken, oldCfHostnameId).catch(() => {});
      }

      return Response.json({ domain: customDomain });
    } catch (err) {
      // Clean up new CF hostname if DB write failed
      await deleteCustomHostname(zoneId, apiToken, cfHostnameId).catch(() => {});
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to set domain' },
        { status: 400 }
      );
    }
  }

  if (intent === 'remove') {
    const zoneId = env.CF_ZONE_ID;
    const apiToken = env.CF_API_TOKEN;

    const existing = await getOrgCustomDomain(authEnv, orgId);
    if (!existing) {
      return Response.json({ error: 'No custom domain configured' }, { status: 404 });
    }

    // Delete CF custom hostname
    if (existing.cf_hostname_id && zoneId && apiToken) {
      await deleteCustomHostname(zoneId, apiToken, existing.cf_hostname_id);
    }

    await removeOrgCustomDomain(authEnv, orgId, authContext.user.id);
    return Response.json({ success: true });
  }

  if (intent === 'checkStatus') {
    const zoneId = env.CF_ZONE_ID;
    const apiToken = env.CF_API_TOKEN;

    const existing = await getOrgCustomDomain(authEnv, orgId);
    if (!existing) {
      return Response.json({ error: 'No custom domain configured' }, { status: 404 });
    }

    if (existing.cf_hostname_id && zoneId && apiToken) {
      const cfStatus = await getCustomHostnameStatus(zoneId, apiToken, existing.cf_hostname_id);
      if (cfStatus) {
        const cfActive = cfStatus.status === 'active';
        const sslActive = cfStatus.ssl.status === 'active';
        const newStatus = cfActive && sslActive ? 'active' :
                          cfActive || cfStatus.status === 'pending' ? 'pending' : 'failed';
        const updated = await updateOrgCustomDomainStatus(
          authEnv, orgId, existing.domain,
          newStatus as 'pending' | 'active' | 'failed',
          cfStatus.ssl.status,
          existing.cf_hostname_id
        );
        return Response.json({ domain: updated });
      }
    }

    return Response.json({ domain: existing });
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}
