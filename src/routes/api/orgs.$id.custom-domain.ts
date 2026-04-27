import type { Route } from './+types/orgs.$id.custom-domain';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript, isOrgAdmin } from '@/lib/auth-do';
import {
  createOrRefreshCustomHostname,
  deleteCustomHostname,
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

function normalizeHostname(value: FormDataEntryValue | null): string {
  return String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
}

function isValidCustomHostname(hostname: string): boolean {
  if (
    !hostname ||
    hostname.length > 253 ||
    hostname.includes('*') ||
    hostname.startsWith('.') ||
    hostname.endsWith('.') ||
    hostname.endsWith('.camelai.app') ||
    hostname.endsWith('.camelai.dev')
  ) {
    return false;
  }

  return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname);
}

// GET - Return exact custom domains configured on the org's apps.
export async function loader({ request, params, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = params.id;

  if (authContext.currentOrg.id !== orgId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const scripts = await orgStub.listWorkerScripts();
  return Response.json({
    domains: scripts
      .filter((script) => script.custom_domain_hostname)
      .map((script) => ({
        script_name: script.script_name,
        hostname: script.custom_domain_hostname,
        status: script.custom_domain_status,
        ssl_status: script.custom_domain_ssl_status,
        error: script.custom_domain_error,
      })),
  });
}

// POST - set or remove an exact custom hostname for one app.
export async function action({ request, params, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = params.id;

  if (authContext.currentOrg.id !== orgId) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }

  const admin = await isOrgAdmin(authEnv, authContext.user.id, orgId);
  if (!admin) {
    return Response.json({ error: 'Only admins can manage custom domains' }, { status: 403 });
  }

  const formData = await request.formData();
  const intent = String(formData.get('intent') ?? '');
  const scriptName = String(formData.get('scriptName') ?? '').trim();
  if (!scriptName) {
    return Response.json({ error: 'App is required' }, { status: 400 });
  }

  const script = await getWorkerScript(authEnv, orgId, scriptName);
  if (!script) {
    return Response.json({ error: 'App not found' }, { status: 404 });
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(orgId));
  const zoneId = env.CF_ZONE_ID?.trim();
  const apiToken = env.CF_API_TOKEN?.trim();

  if (intent === 'set') {
    const hostname = normalizeHostname(formData.get('hostname') ?? formData.get('domain'));
    if (!isValidCustomHostname(hostname)) {
      return Response.json(
        { error: 'Enter one exact hostname, like example.com or app.example.com. Wildcards are not supported.' },
        { status: 400 }
      );
    }

    const scripts = await orgStub.listWorkerScripts();
    const conflictingScript = scripts.find(
      (candidate) =>
        candidate.script_name !== scriptName &&
        candidate.custom_domain_hostname === hostname
    );
    if (conflictingScript) {
      return Response.json(
        { error: `That hostname is already assigned to ${conflictingScript.script_name}` },
        { status: 409 }
      );
    }

    if (!zoneId || !apiToken) {
      return Response.json({ error: 'Cloudflare API is not configured' }, { status: 500 });
    }

    try {
      const record = await createOrRefreshCustomHostname(zoneId, apiToken, hostname);
      if (!record) {
        await orgStub.updateWorkerScriptCustomDomain(scriptName, {
          hostname,
          error: 'Failed to create or locate Cloudflare custom hostname',
        });
        return Response.json(
          { error: 'Failed to create or locate Cloudflare custom hostname' },
          { status: 502 }
        );
      }

      if (
        script.custom_domain_cf_hostname_id &&
        script.custom_domain_cf_hostname_id !== record.id
      ) {
        await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
      }

      const updated = await orgStub.updateWorkerScriptCustomDomain(scriptName, {
        hostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
        updated_at: Date.now(),
      });

      return Response.json({
        success: true,
        app: updated,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to set custom domain';
      await orgStub.updateWorkerScriptCustomDomain(scriptName, {
        hostname,
        error: message,
        updated_at: Date.now(),
      });
      return Response.json({ error: message }, { status: 502 });
    }
  }

  if (intent === 'remove') {
    if (zoneId && apiToken && script.custom_domain_cf_hostname_id) {
      await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
    }
    await orgStub.clearWorkerScriptCustomDomain(scriptName);
    return Response.json({ success: true });
  }

  return Response.json({ error: 'Unknown intent' }, { status: 400 });
}
