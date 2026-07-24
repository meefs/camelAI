import type { WorkspaceIntegrationDefinition } from "@/lib/integration-definition";
import { getProviderMcpDefinition } from "@/lib/provider-mcp-registry";

export type ConnectionCapability =
  | "query_database"
  | "mcp_tools"
  | "typed_operations"
  | "authenticated_fetch"
  | "channel_send"
  | "slack_api"
  | "project_credentials";

export type ConnectionExecutionDriver =
  | "sql"
  | "channel"
  | "curated"
  | "remote_mcp"
  | "provider_mcp"
  | "authenticated_http"
  | "configuration";

export type ConnectionVerificationStrategy =
  | "database_query"
  | "mcp_discovery"
  | "slack_auth"
  | "telegram_setup"
  | "discord_channel_access"
  | "curated_api"
  | "http_configuration"
  | "credential_configuration";

export type ConnectionVerificationStatus =
  | "ready"
  | "configured"
  | "needs_authorization"
  | "misconfigured"
  | "degraded"
  | "unknown";

export interface ConnectionContract {
  schemaVersion: 1;
  integrationType: string;
  driver: ConnectionExecutionDriver;
  capabilities: ConnectionCapability[];
  verification: {
    strategy: ConnectionVerificationStrategy;
    live: boolean;
  };
  permissions: {
    read: boolean;
    write: boolean;
  };
  provenance: "builtin" | "workspace_definition";
}

export interface ConnectionContractOptions {
  config?: Record<string, unknown>;
  definition?: WorkspaceIntegrationDefinition | null;
}

const SQL_CONNECTION_TYPES = new Set([
  "bigquery",
  "clickhouse",
  "databricks",
  "mysql",
  "neon",
  "planetscale",
  "postgres",
  "snowflake",
  "turso",
]);

function uniqueCapabilities(values: ConnectionCapability[]): ConnectionCapability[] {
  return [...new Set(values)];
}

function operationPermissions(
  definition: WorkspaceIntegrationDefinition | null | undefined,
  config: Record<string, unknown>,
) {
  const operations = definition?.operations ?? [];
  return {
    read: operations.some((operation) => operation.access === "read"),
    write: config.operation_policy === "all" &&
      operations.some((operation) => operation.access === "write"),
  };
}

/**
 * Returns the product contract for a connection. This is deliberately pure so
 * setup UI, agent catalogs, runtime routing, and tests all make the same claims.
 */
export function getConnectionContract(
  integrationType: string,
  options: ConnectionContractOptions = {},
): ConnectionContract {
  const definition = options.definition;
  const config = options.config ?? {};
  const importedPermissions = operationPermissions(definition, config);
  const importedCapabilities: ConnectionCapability[] = definition?.operations.length
    ? ["typed_operations"]
    : [];
  const provenance = definition ? "workspace_definition" : "builtin";

  if (SQL_CONNECTION_TYPES.has(integrationType)) {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "sql",
      capabilities: uniqueCapabilities(["query_database", "mcp_tools", ...importedCapabilities]),
      verification: {
        strategy: integrationType === "databricks" ? "mcp_discovery" : "database_query",
        live: true,
      },
      permissions: {
        read: true,
        write: importedPermissions.write,
      },
      provenance,
    };
  }

  if (integrationType === "slack") {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "channel",
      capabilities: ["channel_send", "slack_api"],
      verification: { strategy: "slack_auth", live: true },
      permissions: { read: true, write: true },
      provenance,
    };
  }

  if (integrationType === "telegram") {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "channel",
      capabilities: ["channel_send"],
      verification: { strategy: "telegram_setup", live: false },
      permissions: { read: false, write: true },
      provenance,
    };
  }

  if (integrationType === "discord_channel") {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "channel",
      capabilities: ["channel_send"],
      verification: { strategy: "discord_channel_access", live: true },
      permissions: { read: true, write: true },
      provenance,
    };
  }

  if (integrationType === "google_analytics") {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "curated",
      capabilities: uniqueCapabilities(["typed_operations", ...importedCapabilities]),
      verification: { strategy: "curated_api", live: true },
      permissions: { read: true, write: false },
      provenance,
    };
  }

  if (integrationType === "remote_mcp") {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "remote_mcp",
      capabilities: ["mcp_tools"],
      verification: { strategy: "mcp_discovery", live: true },
      permissions: { read: true, write: true },
      provenance,
    };
  }

  if (getProviderMcpDefinition(integrationType)) {
    return {
      schemaVersion: 1,
      integrationType,
      driver: "provider_mcp",
      capabilities: uniqueCapabilities(["mcp_tools", ...importedCapabilities]),
      verification: { strategy: "mcp_discovery", live: true },
      permissions: {
        read: true,
        // MCP tool permissions are ultimately enforced by the provider and the
        // per-tool policy. The contract records that writes may be available.
        write: true,
      },
      provenance,
    };
  }

  if (integrationType === "other" || integrationType === "resend") {
    const hasBaseUrl = integrationType === "resend" || (
      typeof config.base_url === "string" && config.base_url.trim().length > 0
    );
    return {
      schemaVersion: 1,
      integrationType,
      driver: "authenticated_http",
      capabilities: uniqueCapabilities([
        ...importedCapabilities,
        ...(hasBaseUrl ? ["authenticated_fetch" as const] : []),
      ]),
      verification: { strategy: "http_configuration", live: false },
      permissions: definition
        ? importedPermissions
        : { read: true, write: true },
      provenance,
    };
  }

  return {
    schemaVersion: 1,
    integrationType,
    driver: "configuration",
    capabilities: uniqueCapabilities(["project_credentials", ...importedCapabilities]),
    verification: { strategy: "credential_configuration", live: false },
    // Credential injection is configuration, not an executable API surface.
    permissions: definition ? importedPermissions : { read: false, write: false },
    provenance,
  };
}
