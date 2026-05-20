import type { WorkspaceDO } from "./workspace";
import type { ConnectionSetupResponse } from "./chat-thread-browser-prompts";
import type { IntegrationCategory } from "../../../src/types";
import { encryptCredentials } from "../../../src/lib/integration-crypto";
import {
  getAllIntegrations,
  getIntegrationsByCategory,
  getIntegrationDefinition,
  shouldStoreIntegrationCredentials,
  validateConfig,
  validateCredentials,
  type DynamicField,
  type DynamicIntegrationSchema,
} from "../../../src/lib/integration-registry";

interface CodeModeIntegrationsEnv {
  INTEGRATION_SECRET_KEY: string;
}

interface CodeModeIntegrationsOptions {
  env: CodeModeIntegrationsEnv;
  workspaceStub: DurableObjectStub<WorkspaceDO>;
  userId?: string;
  promptConnectionSetup: (input: {
    integrationType: string;
    suggestedName?: string;
    message?: string;
    instructions?: string;
    dynamicSchema?: DynamicIntegrationSchema;
  }) => Promise<ConnectionSetupResponse>;
}

function recommendedAccess(integrationId: string): Record<string, unknown> {
  return {
    tool: "js_exec",
    inspect_methods: "await env.CONNECTIONS.methods()",
    call_pattern: "await connections.<alias>.<method>({ ...input })",
    connection_id: integrationId,
  };
}

export class CodeModeIntegrations {
  constructor(private readonly options: CodeModeIntegrationsOptions) {}

  async list(args: Record<string, unknown>): Promise<unknown> {
    const category = typeof args.category === "string" ? args.category : "";
    const rawIntegrations = await this.options.workspaceStub.getIntegrations();
    const integrations = rawIntegrations.map((record) => {
      let parsedConfig: Record<string, unknown> = {};
      try {
        parsedConfig = record.config ? JSON.parse(record.config) : {};
      } catch {
        parsedConfig = {};
      }
      return {
        id: record.id,
        integration_type: record.integration_type,
        name: record.name,
        category: record.category,
        auth_method: record.auth_method,
        has_credentials: Boolean(record.credentials_encrypted),
        created_at: record.created_at,
        updated_at: record.updated_at,
        config: parsedConfig,
      };
    });
    const filtered = category
      ? integrations.filter((integration) => integration.category === category)
      : integrations;
    return {
      count: filtered.length,
      integrations: filtered.map((integration) => ({
        id: integration.id,
        type: integration.integration_type,
        name: integration.name,
        category: integration.category,
        auth_method: integration.auth_method,
        has_credentials: integration.has_credentials,
        created_at: new Date(integration.created_at).toISOString(),
        updated_at: new Date(integration.updated_at).toISOString(),
        recommended_access: recommendedAccess(integration.id),
        display_name: integration.integration_type === "other" && typeof integration.config.display_name === "string"
          ? integration.config.display_name
          : undefined,
      })),
    };
  }

  listTypes(args: Record<string, unknown>): unknown {
    const category = typeof args.category === "string" ? args.category : "";
    const validCategory: IntegrationCategory | "" =
      category === "databases" ||
      category === "saas" ||
      category === "ai_services" ||
      category === "cloud_providers" ||
      category === "communication"
        ? category
        : "";
    const definitions = validCategory ? getIntegrationsByCategory(validCategory) : getAllIntegrations();
    const types = definitions.map((definition) => ({
      type: definition.type,
      display_name: definition.displayName,
      description: definition.description,
      category: definition.category,
      auth_method: definition.authMethod,
      config_fields: definition.configSchema.map((field) => ({
        name: field.name,
        label: field.label,
        type: field.type,
        required: field.required,
        description: field.description,
      })),
      credential_fields: definition.credentialSchema.map((field) => ({
        name: field.name,
        label: field.label,
        required: field.required,
        description: field.description,
      })),
      supports_proxy: false,
    }));
    const byCategory: Record<string, typeof types> = {};
    for (const type of types) {
      if (!byCategory[type.category]) byCategory[type.category] = [];
      byCategory[type.category].push(type);
    }
    return { total_count: types.length, by_category: byCategory };
  }

  async create(args: Record<string, unknown>): Promise<unknown> {
    const integrationType = typeof args.integration_type === "string" ? args.integration_type.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    const config = args.config && typeof args.config === "object" ? args.config as Record<string, unknown> : {};
    const credentials = args.credentials && typeof args.credentials === "object" ? args.credentials as Record<string, unknown> : {};
    if (!integrationType) throw new Error("integration_type is required");
    if (!name) throw new Error("name is required");
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return {
        success: false,
        error: `Unknown integration type: ${integrationType}. Use list_integration_types to see available types.`,
      };
    }
    const configErrors = validateConfig(integrationType, config);
    if (configErrors.length > 0) {
      return { success: false, error: "Invalid configuration", validation_errors: configErrors };
    }
    const credentialErrors = validateCredentials(integrationType, credentials);
    if (credentialErrors.length > 0) {
      return { success: false, error: "Invalid credentials", validation_errors: credentialErrors };
    }
    const credentialsEncrypted = shouldStoreIntegrationCredentials(integrationType, credentials)
      ? await encryptCredentials(credentials, this.options.env.INTEGRATION_SECRET_KEY)
      : "";
    const integrationId = crypto.randomUUID();
    await this.options.workspaceStub.createIntegration(
      integrationId,
      integrationType,
      name,
      definition.category,
      definition.authMethod,
      JSON.stringify(config),
      credentialsEncrypted,
      this.options.userId || "system",
    );
    return {
      success: true,
      integration: {
        id: integrationId,
        type: integrationType,
        name,
        category: definition.category,
        recommended_access: recommendedAccess(integrationId),
      },
      message: `Integration '${name}' created successfully.`,
    };
  }

  async promptConnectionSetup(args: Record<string, unknown>): Promise<unknown> {
    const integrationType = typeof args.integration_type === "string" ? args.integration_type.trim() : "";
    if (!integrationType) throw new Error("integration_type is required");
    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return {
        success: false,
        error: `Unknown integration type: ${integrationType}. Use list_integration_types to see available types.`,
      };
    }
    const dynamicSchema = integrationType === "other" && Array.isArray(args.fields)
      ? {
          displayName:
            typeof args.display_name === "string" && args.display_name.trim()
              ? args.display_name.trim()
              : typeof args.suggested_name === "string" && args.suggested_name.trim()
                ? args.suggested_name.trim()
                : "Custom Integration",
          description: typeof args.description === "string" ? args.description : undefined,
          instructions: typeof args.instructions === "string" ? args.instructions : undefined,
          fields: args.fields as DynamicField[],
        }
      : undefined;
    const response = await this.options.promptConnectionSetup({
      integrationType,
      suggestedName:
        typeof args.suggested_name === "string" && args.suggested_name.trim()
          ? args.suggested_name.trim()
          : dynamicSchema?.displayName ?? definition.displayName,
      message: typeof args.message === "string" ? args.message : undefined,
      instructions: typeof args.instructions === "string" ? args.instructions : undefined,
      dynamicSchema,
    });
    if (response.cancelled) {
      return { success: false, cancelled: true, message: "User cancelled the connection setup" };
    }
    if (!response.integration) {
      return { success: false, error: "Invalid response from user - missing integration data" };
    }
    const { type, name, config, credentials } = response.integration;
    const responseDefinition = getIntegrationDefinition(type);
    if (!responseDefinition) {
      return { success: false, error: `Unknown integration type from user response: ${type}` };
    }
    if (credentials._oauth_completed && credentials.integration_id) {
      const integrationId = String(credentials.integration_id);
      return {
        success: true,
        integration: {
          id: integrationId,
          type,
          name,
          category: responseDefinition.category,
          recommended_access: recommendedAccess(integrationId),
        },
        message: `Integration '${name}' connected successfully via OAuth.`,
      };
    }
    const finalConfig =
      type === "other" && dynamicSchema?.fields.length
        ? {
            ...config,
            display_name: dynamicSchema.displayName,
            dynamic_fields: dynamicSchema.fields,
          }
        : config;
    return this.create({
      integration_type: type,
      name,
      config: finalConfig,
      credentials,
    });
  }
}
