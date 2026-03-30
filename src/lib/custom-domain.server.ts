import type { WorkerScript } from '@/types';
import {
  findCustomHostnameByHostname,
  getCustomHostnameStatus,
} from '../../workers/main/src/cf-api-proxy';
import {
  getExpectedCustomDomainHostname,
  isAppCustomDomainReady,
} from './app-url';

const CUSTOM_DOMAIN_REFRESH_INTERVAL_MS = 60 * 1000;

interface CustomDomainRefreshEnv {
  ORG: DurableObjectNamespace<any>;
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
}

interface OrgCustomDomainRpc {
  updateWorkerScriptCustomDomain(
    scriptName: string,
    input: {
      hostname: string;
      cf_hostname_id: string;
      status: string;
      ssl_status: string;
      error: string | null;
      updated_at: number;
    }
  ): Promise<WorkerScript | null>;
}

function shouldRefreshWorkerScriptCustomDomain(
  script: WorkerScript,
  orgCustomDomain: string,
  now: number
): boolean {
  if (isAppCustomDomainReady(script, orgCustomDomain)) {
    return false;
  }

  if (script.custom_domain_hostname && script.custom_domain_hostname !== getExpectedCustomDomainHostname(script.script_name, orgCustomDomain)) {
    return true;
  }

  if (!script.custom_domain_updated_at) {
    return true;
  }

  return now - script.custom_domain_updated_at >= CUSTOM_DOMAIN_REFRESH_INTERVAL_MS;
}

export async function refreshWorkerScriptCustomDomainState(
  env: CustomDomainRefreshEnv,
  orgId: string,
  script: WorkerScript,
  orgCustomDomain: string | null | undefined,
  now = Date.now()
): Promise<WorkerScript> {
  const zoneId = env.CF_ZONE_ID?.trim();
  const apiToken = env.CF_API_TOKEN?.trim();
  if (!orgCustomDomain || !zoneId || !apiToken) {
    return script;
  }

  if (!shouldRefreshWorkerScriptCustomDomain(script, orgCustomDomain, now)) {
    return script;
  }

  try {
    const expectedHostname = getExpectedCustomDomainHostname(script.script_name, orgCustomDomain);
    let record = null;

    if (script.custom_domain_cf_hostname_id && script.custom_domain_hostname === expectedHostname) {
      record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
    }

    if (!record) {
      record = await findCustomHostnameByHostname(zoneId, apiToken, expectedHostname);
    }

    if (!record) {
      return script;
    }

    const orgNamespace = env.ORG as unknown as {
      idFromName(name: string): DurableObjectId;
      get(id: DurableObjectId): OrgCustomDomainRpc;
    };
    const orgStub = orgNamespace.get(orgNamespace.idFromName(orgId));
    return (
      await orgStub.updateWorkerScriptCustomDomain(script.script_name, {
        hostname: expectedHostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
        updated_at: now,
      })
    ) ?? script;
  } catch (error) {
    console.warn(
      `[custom-domains] failed to refresh hostname state for ${script.script_name}:`,
      error
    );
    return script;
  }
}

export async function refreshWorkerScriptCustomDomainStates(
  env: CustomDomainRefreshEnv,
  orgId: string,
  scripts: WorkerScript[],
  orgCustomDomain: string | null | undefined
): Promise<WorkerScript[]> {
  if (!orgCustomDomain || !env.CF_ZONE_ID?.trim() || !env.CF_API_TOKEN?.trim()) {
    return scripts;
  }

  const now = Date.now();
  return Promise.all(
    scripts.map((script) =>
      refreshWorkerScriptCustomDomainState(env, orgId, script, orgCustomDomain, now)
    )
  );
}
