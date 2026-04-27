import type { WorkerScript } from '../types';
import { getExpectedCustomDomainHostname, isAppCustomDomainReady } from './app-url';
import { createOrRefreshCustomHostname } from '../../workers/main/src/cf-api-proxy';

interface CustomDomainAdminEnv {
  ORG: {
    idFromName(name: string): unknown;
    get(id: unknown): unknown;
  };
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
}

interface CustomDomainAdminOrgStub {
  getInfo(): Promise<{ id: string } | null>;
  getCustomDomain(): Promise<{ domain: string } | null>;
  listWorkerScripts(): Promise<WorkerScript[]>;
  updateWorkerScriptCustomDomain(
    scriptName: string,
    input: {
      hostname: string;
      cf_hostname_id?: string | null;
      status?: string | null;
      ssl_status?: string | null;
      error?: string | null;
      updated_at?: number;
    }
  ): Promise<WorkerScript | null>;
}

export interface AdminCustomDomainRefreshAppResult {
  script_name: string;
  hostname: string;
  action: 'skipped_active' | 'refreshed' | 'failed';
  cf_hostname_id: string | null;
  status: string | null;
  ssl_status: string | null;
  error: string | null;
}

export interface AdminCustomDomainRefreshResult {
  org_id: string;
  domain: string | null;
  total_apps: number;
  attempted: number;
  refreshed: number;
  failed: number;
  skipped_active: number;
  apps: AdminCustomDomainRefreshAppResult[];
}

export async function refreshOrgCustomDomainHostnamesForAdmin(
  env: CustomDomainAdminEnv,
  orgId: string,
  options: { includeActive?: boolean } = {}
): Promise<AdminCustomDomainRefreshResult | null> {
  const zoneId = env.CF_ZONE_ID?.trim();
  const apiToken = env.CF_API_TOKEN?.trim();
  if (!zoneId || !apiToken) {
    throw new Error('Cloudflare API is not configured');
  }

  const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as CustomDomainAdminOrgStub;
  const orgInfo = await orgStub.getInfo();
  if (!orgInfo) {
    return null;
  }

  const customDomain = await orgStub.getCustomDomain();
  if (!customDomain) {
    return {
      org_id: orgId,
      domain: null,
      total_apps: 0,
      attempted: 0,
      refreshed: 0,
      failed: 0,
      skipped_active: 0,
      apps: [],
    };
  }

  const scripts = await orgStub.listWorkerScripts();
  const result: AdminCustomDomainRefreshResult = {
    org_id: orgId,
    domain: customDomain.domain,
    total_apps: scripts.length,
    attempted: 0,
    refreshed: 0,
    failed: 0,
    skipped_active: 0,
    apps: [],
  };

  for (const script of scripts) {
    const hostname = getExpectedCustomDomainHostname(script.script_name, customDomain.domain);
    if (!options.includeActive && isAppCustomDomainReady(script, customDomain.domain)) {
      result.skipped_active += 1;
      result.apps.push({
        script_name: script.script_name,
        hostname,
        action: 'skipped_active',
        cf_hostname_id: script.custom_domain_cf_hostname_id,
        status: script.custom_domain_status,
        ssl_status: script.custom_domain_ssl_status,
        error: null,
      });
      continue;
    }

    result.attempted += 1;
    try {
      const record = await createOrRefreshCustomHostname(zoneId, apiToken, hostname);
      if (!record) {
        const error = 'Failed to create or refresh Cloudflare custom hostname';
        await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
          hostname,
          cf_hostname_id: null,
          status: null,
          ssl_status: null,
          error,
          updated_at: Date.now(),
        });
        result.failed += 1;
        result.apps.push({
          script_name: script.script_name,
          hostname,
          action: 'failed',
          cf_hostname_id: null,
          status: null,
          ssl_status: null,
          error,
        });
        continue;
      }

      await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
        hostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
        updated_at: Date.now(),
      });
      result.refreshed += 1;
      result.apps.push({
        script_name: script.script_name,
        hostname,
        action: 'refreshed',
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
        hostname,
        error: message,
        updated_at: Date.now(),
      });
      result.failed += 1;
      result.apps.push({
        script_name: script.script_name,
        hostname,
        action: 'failed',
        cf_hostname_id: script.custom_domain_cf_hostname_id,
        status: script.custom_domain_status,
        ssl_status: script.custom_domain_ssl_status,
        error: message,
      });
    }
  }

  return result;
}
