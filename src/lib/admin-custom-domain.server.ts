import type { WorkerScript } from '../types';
import { getExpectedCustomDomainHostname, isAppCustomDomainReady } from './app-url';
import {
  createOrRefreshCustomHostname,
  deleteCustomHostname,
  extractCustomHostnameDcvRecord,
  listCustomHostnamesByBaseDomain,
  type CustomHostnameDcvRecord,
} from '../../workers/main/src/cf-api-proxy';

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
  getCustomDomain(): Promise<{
    domain: string;
    cf_hostname_id: string | null;
    status: string | null;
    ssl_status: string | null;
  } | null>;
  listWorkerScripts(): Promise<WorkerScript[]>;
  updateCustomDomainStatus(
    domain: string,
    status: 'pending' | 'active' | 'failed',
    sslStatus?: string | null,
    cfHostnameId?: string
  ): Promise<unknown>;
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
  dcv_record: CustomHostnameDcvRecord | null;
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
  const orgReady =
    customDomain.status === 'active' && customDomain.ssl_status === 'active';
  const appsReady = scripts.every((script) =>
    isAppCustomDomainReady(script, customDomain.domain)
  );
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

  let record = null;
  let recordError: string | null = null;
  const shouldRefreshWildcard = options.includeActive || !orgReady;
  if (shouldRefreshWildcard) {
    try {
      record = await createOrRefreshCustomHostname(zoneId, apiToken, customDomain.domain, {
        wildcard: true,
      });
      if (!record) {
        recordError = 'Failed to create or refresh Cloudflare wildcard custom hostname';
      } else {
        await orgStub.updateCustomDomainStatus(
          customDomain.domain,
          record.status === 'active' ? 'active' : 'pending',
          record.ssl.status,
          record.id
        );
        const staleHostnames = await listCustomHostnamesByBaseDomain(
          zoneId,
          apiToken,
          customDomain.domain
        );
        for (const hostname of staleHostnames) {
          if (hostname.id !== record.id) {
            await deleteCustomHostname(zoneId, apiToken, hostname.id);
          }
        }
      }
    } catch (error) {
      recordError = error instanceof Error ? error.message : String(error);
    }
  } else if (customDomain.cf_hostname_id) {
    record = {
      id: customDomain.cf_hostname_id,
      hostname: customDomain.domain,
      status: customDomain.status ?? 'active',
      ssl: {
        status: customDomain.ssl_status ?? 'active',
        method: 'txt',
        type: 'dv',
      },
      created_at: '',
    };
  }

  for (const script of scripts) {
    const hostname = getExpectedCustomDomainHostname(script.script_name, customDomain.domain);
    if (!options.includeActive && orgReady && appsReady && isAppCustomDomainReady(script, customDomain.domain)) {
      result.skipped_active += 1;
      result.apps.push({
        script_name: script.script_name,
        hostname,
        action: 'skipped_active',
        cf_hostname_id: script.custom_domain_cf_hostname_id,
        status: script.custom_domain_status,
        ssl_status: script.custom_domain_ssl_status,
        dcv_record: null,
        error: null,
      });
      continue;
    }

    result.attempted += 1;
    if (!record) {
      const error = recordError ?? 'Failed to create or refresh Cloudflare wildcard custom hostname';
      try {
        await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
          hostname,
          cf_hostname_id: null,
          status: null,
          ssl_status: null,
          error,
          updated_at: Date.now(),
        });
      } catch {}
      result.failed += 1;
      result.apps.push({
        script_name: script.script_name,
        hostname,
        action: 'failed',
        cf_hostname_id: null,
        status: null,
        ssl_status: null,
        dcv_record: null,
        error,
      });
      continue;
    }

    try {
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
        dcv_record: extractCustomHostnameDcvRecord(record),
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
        dcv_record: null,
        error: message,
      });
    }
  }

  return result;
}
