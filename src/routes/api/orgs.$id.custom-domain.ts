import { waitUntil } from 'cloudflare:workers';
import type { Route } from './+types/orgs.$id.custom-domain';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { isOrgAdmin } from '@/lib/auth-do';
import {
  getOrgCustomDomain,
  setOrgCustomDomain,
  removeOrgCustomDomain,
} from '@/lib/auth-do';
import {
  createCustomHostname,
  deleteCustomHostname,
  findCustomHostnameByHostname,
  listCustomHostnamesByBaseDomain,
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

// POST - set or remove
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

    try {
      const existing = await getOrgCustomDomain(authEnv, orgId);
      const oldDomain = existing?.domain;
      const customDomain = await setOrgCustomDomain(
        authEnv, orgId, domain, authContext.user.id
      );

      // Backfill: create CF hostnames for all existing deployed apps
      const zoneId = env.CF_ZONE_ID;
      const apiToken = env.CF_API_TOKEN?.trim();
      if (zoneId && apiToken) {
        const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
        waitUntil(
          (async () => {
            await orgStub.clearWorkerScriptCustomDomains();

            if (oldDomain && oldDomain !== domain) {
              await cleanupCustomHostnames(zoneId, apiToken, oldDomain);
            }

            const scripts = await orgStub.listWorkerScripts();
            for (const script of scripts) {
              const appHostname = `${script.script_name}.${domain}`;
              try {
                // Use the zone's configured fallback origin for normal app hostnames.
                let result = await createCustomHostname(zoneId, apiToken, appHostname);
                if (!result) {
                  result = await findCustomHostnameByHostname(zoneId, apiToken, appHostname);
                }
                if (result) {
                  await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                    hostname: appHostname,
                    cf_hostname_id: result.id,
                    status: result.status,
                    ssl_status: result.ssl.status,
                    error: null,
                  });
                  console.log(`[custom-domains] backfill: synced hostname ${appHostname} status=${result.status}`);
                } else {
                  await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                    hostname: appHostname,
                    error: 'Failed to create or locate Cloudflare custom hostname',
                  });
                  console.error(`[custom-domains] backfill: missing hostname after create ${appHostname}`);
                }
              } catch (err) {
                await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                  hostname: appHostname,
                  error: err instanceof Error ? err.message : String(err),
                });
                console.error(`[custom-domains] backfill: failed for ${appHostname}:`, err);
              }
            }
          })().catch(err => console.error('[custom-domains] backfill failed:', err))
        );
      } else {
        waitUntil(
          authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
            .clearWorkerScriptCustomDomains()
            .catch(err => console.error('[custom-domains] clear state failed:', err))
        );
      }

      return Response.json({ domain: customDomain });
    } catch (err) {
      return Response.json(
        { error: err instanceof Error ? err.message : 'Failed to set domain' },
        { status: 400 }
      );
    }
  }

  if (intent === 'remove') {
    const existing = await getOrgCustomDomain(authEnv, orgId);
    if (!existing) {
      return Response.json({ error: 'No custom domain configured' }, { status: 404 });
    }

    await removeOrgCustomDomain(authEnv, orgId, authContext.user.id);
    waitUntil(
      authEnv.ORG.get(authEnv.ORG.idFromName(orgId))
        .clearWorkerScriptCustomDomains()
        .catch(err => console.error('[custom-domains] clear state failed:', err))
    );

    // Clean up all per-app CF hostnames for this domain in the background
    const zoneId = env.CF_ZONE_ID;
    const apiToken = env.CF_API_TOKEN?.trim();
    if (zoneId && apiToken) {
      waitUntil(
        cleanupCustomHostnames(zoneId, apiToken, existing.domain)
          .catch(err => console.error('[custom-domains] cleanup failed:', err))
      );
    }

    return Response.json({ success: true });
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}

/**
 * Delete all CF custom hostnames matching *.{baseDomain} by searching
 * the CF API for hostnames ending with the base domain.
 */
async function cleanupCustomHostnames(
  zoneId: string,
  apiToken: string,
  baseDomain: string
): Promise<void> {
  const hostnames = await listCustomHostnamesByBaseDomain(zoneId, apiToken, baseDomain);
  for (const hostname of hostnames) {
    await deleteCustomHostname(zoneId, apiToken, hostname.id).catch(err =>
      console.error(`[custom-domains] cleanup: failed to delete ${hostname.hostname}:`, err)
    );
    console.log(`[custom-domains] cleanup: deleted ${hostname.hostname}`);
  }
}
