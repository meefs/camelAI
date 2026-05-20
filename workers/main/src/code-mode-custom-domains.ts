import type { OrgDO } from "./auth";
import {
  createOrRefreshCustomHostname,
  deleteCustomHostname,
  findCustomHostnameByHostname,
  getCustomHostnameStatus,
} from "./cf-api-proxy";
import {
  buildCustomDomainDnsCheck,
  getCustomHostnameDnsTarget,
  type CnameLookupResult,
  type CustomDomainDnsCheck,
} from "../../../src/lib/custom-domain-dns";
import {
  getAppCustomDomainDiagnosticState,
  shouldRefreshAppCustomDomainState,
  shouldRetryAppCustomDomainProvisioning,
} from "../../../src/lib/custom-domain-state";

interface CodeModeCustomDomainEnv {
  CF_ZONE_ID?: string;
  CF_API_TOKEN?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
}

interface CodeModeCustomDomainOptions {
  env: CodeModeCustomDomainEnv;
  orgStub: DurableObjectStub<OrgDO>;
  workspaceId: string;
  userId?: string;
}

async function resolveCnameViaDoH(hostname: string): Promise<CnameLookupResult> {
  const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=CNAME`;
  try {
    const resp = await fetch(url, {
      headers: { Accept: "application/dns-json" },
    });
    if (!resp.ok) {
      return {
        status: "unavailable",
        error: `DoH query failed with HTTP ${resp.status}`,
        http_status: resp.status,
      };
    }
    const data = await resp.json() as {
      Status?: number;
      Answer?: Array<{ type: number; data: string }>;
    };
    const dnsStatus = data.Status ?? 0;
    const cname = data.Answer?.find((answer) => answer.type === 5);
    if (!cname) {
      if (dnsStatus !== 0 && dnsStatus !== 3) {
        return {
          status: "unavailable",
          error: `DNS resolver returned status ${dnsStatus}`,
          http_status: null,
        };
      }
      return { status: "missing" };
    }
    return { status: "resolved", target: cname.data.replace(/\.$/, "") };
  } catch (error) {
    return {
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export class CodeModeCustomDomains {
  constructor(private readonly options: CodeModeCustomDomainOptions) {}

  async get(): Promise<unknown> {
    const zoneId = this.options.env.CF_ZONE_ID?.trim();
    const apiToken = this.options.env.CF_API_TOKEN?.trim();
    const dnsTarget = getCustomHostnameDnsTarget({
      cnameTarget: this.options.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: this.options.env.CF_CUSTOM_HOSTNAME_FALLBACK,
    });
    const scripts = await this.options.orgStub.listWorkerScriptsByWorkspace(this.options.workspaceId);
    const now = Date.now();
    const apps = [];
    for (const script of scripts) {
      let currentScript = script;
      if (
        zoneId &&
        apiToken &&
        shouldRefreshAppCustomDomainState(script, null, now) &&
        script.custom_domain_hostname
      ) {
        try {
          let record = null;
          if (script.custom_domain_cf_hostname_id) {
            record = await getCustomHostnameStatus(zoneId, apiToken, script.custom_domain_cf_hostname_id);
          }
          if (!record) {
            record = await findCustomHostnameByHostname(zoneId, apiToken, script.custom_domain_hostname);
          }
          if (record) {
            currentScript =
              (await this.options.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
                hostname: script.custom_domain_hostname,
                cf_hostname_id: record.id,
                status: record.status,
                ssl_status: record.ssl.status,
                error: null,
              })) ?? currentScript;
          }
        } catch {
          // Keep cached state if Cloudflare diagnostics are unavailable.
        }
      }
      const appState = getAppCustomDomainDiagnosticState(currentScript, null);
      const dnsChecks = { routing_cname: null as CustomDomainDnsCheck | null };
      if (appState.hostname) {
        dnsChecks.routing_cname = buildCustomDomainDnsCheck({
          queried: appState.hostname,
          expectedTarget: dnsTarget,
          lookup: await resolveCnameViaDoH(appState.hostname),
        });
      }
      apps.push({
        name: script.script_name,
        hostname: appState.hostname,
        cf_hostname_id: appState.cf_hostname_id,
        status: appState.status,
        ssl_status: appState.ssl_status,
        error: appState.error,
        updated_at: appState.updated_at,
        dns_checks: dnsChecks,
      });
    }
    const configuredApps = apps.filter((app) => app.hostname);
    const activeCount = configuredApps.filter(
      (app) => app.status === "active" && app.ssl_status === "active",
    ).length;
    return {
      configured: configuredApps.length > 0,
      dns_target: dnsTarget,
      apps,
      message:
        configuredApps.length === 0
          ? "No exact custom domains configured."
          : `${activeCount}/${configuredApps.length} configured custom domains have active SSL.`,
    };
  }

  async set(args: Record<string, unknown>): Promise<unknown> {
    const appName = typeof args.app_name === "string" ? args.app_name.trim() : "";
    const hostname = typeof args.hostname === "string"
      ? args.hostname.trim().toLowerCase().replace(/\.$/, "")
      : "";
    if (!appName) throw new Error("app_name is required");
    if (!hostname) throw new Error("hostname is required");
    const member = this.options.userId
      ? await this.options.orgStub.getMember(this.options.userId)
      : null;
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return { success: false, error: "Only org admins can manage custom domains" };
    }
    const script = await this.options.orgStub.getWorkerScript(appName);
    if (!script) return { success: false, error: "App not found" };
    if (script.workspace_id !== this.options.workspaceId) {
      return { success: false, error: `App '${appName}' belongs to a different workspace` };
    }
    const scripts = await this.options.orgStub.listWorkerScriptsByWorkspace(this.options.workspaceId);
    const conflictingScript = scripts.find(
      (candidate) =>
        candidate.script_name !== appName &&
        candidate.custom_domain_hostname === hostname,
    );
    if (conflictingScript) {
      return {
        success: false,
        error: `That hostname is already assigned to ${conflictingScript.script_name}`,
      };
    }
    if (
      hostname.includes("*") ||
      !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hostname)
    ) {
      return { success: false, error: "Invalid exact hostname. Wildcards are not supported." };
    }
    if (hostname.endsWith(".camelai.app") || hostname.endsWith(".camelai.dev")) {
      return { success: false, error: "Cannot use camelAI domains as custom domains" };
    }
    const zoneId = this.options.env.CF_ZONE_ID?.trim();
    const apiToken = this.options.env.CF_API_TOKEN?.trim();
    if (!zoneId || !apiToken) {
      return { success: false, error: "Cloudflare API not configured" };
    }
    const dnsTarget = getCustomHostnameDnsTarget({
      cnameTarget: this.options.env.CF_CUSTOM_HOSTNAME_CNAME_TARGET,
      fallbackOrigin: this.options.env.CF_CUSTOM_HOSTNAME_FALLBACK,
    });
    try {
      const record = await createOrRefreshCustomHostname(zoneId, apiToken, hostname);
      if (!record) {
        await this.options.orgStub.updateWorkerScriptCustomDomain(appName, {
          hostname,
          error: "Failed to create or locate Cloudflare custom hostname",
        });
        return { success: false, error: "Failed to create or locate Cloudflare custom hostname" };
      }
      if (script.custom_domain_cf_hostname_id && script.custom_domain_cf_hostname_id !== record.id) {
        await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
      }
      await this.options.orgStub.updateWorkerScriptCustomDomain(appName, {
        hostname,
        cf_hostname_id: record.id,
        status: record.status,
        ssl_status: record.ssl.status,
        error: null,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.options.orgStub.updateWorkerScriptCustomDomain(appName, { hostname, error: message });
      return { success: false, error: message };
    }
    return {
      success: true,
      app: appName,
      hostname,
      dns_target: dnsTarget,
      routing_record: `${hostname} CNAME ${dnsTarget}`,
      message: `Custom hostname set for ${appName}. Add ${hostname} CNAME ${dnsTarget}.`,
    };
  }

  async remove(args: Record<string, unknown>): Promise<unknown> {
    const appName = typeof args.app_name === "string" ? args.app_name.trim() : "";
    if (!appName) throw new Error("app_name is required");
    const member = this.options.userId
      ? await this.options.orgStub.getMember(this.options.userId)
      : null;
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return { success: false, error: "Only org admins can manage custom domains" };
    }
    const script = await this.options.orgStub.getWorkerScript(appName);
    if (!script?.custom_domain_hostname) {
      return { success: false, error: "No custom domain configured for this app" };
    }
    if (script.workspace_id !== this.options.workspaceId) {
      return { success: false, error: `App '${appName}' belongs to a different workspace` };
    }
    const removedDomain = script.custom_domain_hostname;
    const zoneId = this.options.env.CF_ZONE_ID?.trim();
    const apiToken = this.options.env.CF_API_TOKEN?.trim();
    if (zoneId && apiToken && script.custom_domain_cf_hostname_id) {
      await deleteCustomHostname(zoneId, apiToken, script.custom_domain_cf_hostname_id).catch(() => {});
    }
    await this.options.orgStub.clearWorkerScriptCustomDomain(appName);
    return {
      success: true,
      app: appName,
      removed_domain: removedDomain,
      message: `Custom domain ${removedDomain} removed from ${appName}.`,
    };
  }

  async retryHostnames(): Promise<unknown> {
    const member = this.options.userId
      ? await this.options.orgStub.getMember(this.options.userId)
      : null;
    if (!member || (member.role !== "owner" && member.role !== "admin")) {
      return { success: false, error: "Only org admins can retry hostname provisioning" };
    }
    const zoneId = this.options.env.CF_ZONE_ID?.trim();
    const apiToken = this.options.env.CF_API_TOKEN?.trim();
    if (!zoneId || !apiToken) {
      return { success: false, error: "Cloudflare API not configured" };
    }
    const scripts = await this.options.orgStub.listWorkerScriptsByWorkspace(this.options.workspaceId);
    const scriptsToSync = scripts.filter((script) =>
      shouldRetryAppCustomDomainProvisioning(script, null),
    );
    let succeeded = 0;
    const errors: Array<{ app: string; error: string }> = [];
    for (const script of scriptsToSync) {
      if (!script.custom_domain_hostname) continue;
      try {
        const result = await createOrRefreshCustomHostname(zoneId, apiToken, script.custom_domain_hostname);
        if (result) {
          await this.options.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
            hostname: script.custom_domain_hostname,
            cf_hostname_id: result.id,
            status: result.status,
            ssl_status: result.ssl.status,
            error: null,
          });
          succeeded++;
        } else {
          const error = "Failed to create or locate Cloudflare hostname";
          await this.options.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
            hostname: script.custom_domain_hostname,
            cf_hostname_id: null,
            status: null,
            ssl_status: null,
            error,
          });
          errors.push({ app: script.script_name, error });
        }
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        await this.options.orgStub.updateWorkerScriptCustomDomain(script.script_name, {
          hostname: script.custom_domain_hostname,
          error,
        });
        errors.push({ app: script.script_name, error });
      }
    }
    return {
      success: true,
      retried: scriptsToSync.length,
      succeeded,
      errors: errors.length ? errors : undefined,
      message:
        scriptsToSync.length === 0
          ? "No apps need hostname retry; all are either active or still provisioning normally."
          : `Retried ${scriptsToSync.length} app(s): ${succeeded} succeeded${errors.length ? `, ${errors.length} failed` : ""}.`,
    };
  }
}
