import { Suspense } from 'react';
import { Await, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.connections';
import { requireAuthContext, getAuthEnv, requireWorkspaceAccess } from '@/lib/auth.server';
import {
  createWorkspaceIntegrationRecord,
  deleteWorkspaceIntegrationRecord,
  getWorkspaceIntegrationRecord,
  isOrgAdmin,
  listWorkspaceIntegrationRecords,
  updateWorkspaceIntegrationRecord,
  workspaceIntegrationNameExists,
} from '@/lib/auth-do';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import {
  INTEGRATION_REGISTRY,
  getIntegrationDefinition,
  isCredentialFieldRequired,
  shouldShowConfigField,
  shouldShowCredentialField,
  shouldStoreIntegrationCredentials,
} from '@/lib/integration-registry';
import { decryptCredentials, encryptCredentials } from '@/lib/integration-crypto';
import {
  normalizeRemoteMcpUrl,
  validateRemoteMcpConnection,
} from '@/lib/remote-mcp';
import {
  buildTelegramDeepLink,
  generateTelegramSetupToken,
  getTelegramRegistryName,
  normalizeTelegramBotUsername,
  TELEGRAM_SETUP_TTL_SECONDS,
  type TelegramSetupRecord,
} from '@/lib/telegram-channel';
import type { WorkspaceIntegrationRecord } from '../../workers/main/src/workspace';
import ConnectionsClient from '@/components/pages/connections/connections-client';
import { ConnectionsLoadingSkeleton } from '@/components/pages/connections/connections-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import { shouldRevalidateConnectionsRoute } from '@/lib/connections-route-revalidation';
import {
  buildWorkspaceEmailAddress,
  getWorkspaceEmailDomain,
} from '@/lib/workspace-email';
import { getBillingPlanLimits } from '@/lib/billing-plans';
import type { Integration, User } from '@/types';
import type { ConnectionListItem } from '@/lib/connections-shared';
import { projectsToMentionables, type MentionableProject } from '@/lib/mentions';
import {
  loadUserProfileSummaries,
  type UserProfileSummary,
} from '@/lib/user-profiles.server';

const CONNECTION_MANAGEMENT_INTENTS = new Set([
  'createIntegration',
  'updateIntegration',
  'deleteIntegration',
  'duplicateIntegration',
]);

export function shouldRevalidate(
  args: Parameters<typeof shouldRevalidateConnectionsRoute>[0],
) {
  return shouldRevalidateConnectionsRoute(args);
}

async function loadWorkspaceMentionProjects(
  env: unknown,
  workspaceId: string,
): Promise<MentionableProject[]> {
  const { WorkspaceFilesystemClient } = await import(
    "../../workers/main/src/workspace-filesystem-do"
  );
  const projects = await new WorkspaceFilesystemClient(
    env as never,
    workspaceId,
  ).listProjects();
  return projectsToMentionables(projects);
}

function parseIntegrationConfig(rawConfig: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function validateRequiredIntegrationFields(
  definition: NonNullable<ReturnType<typeof getIntegrationDefinition>>,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): string[] {
  const errors: string[] = [];
  for (const field of definition.configSchema) {
    if (!shouldShowConfigField(definition.type, field.name, config)) continue;
    const value = config[field.name];
    if (field.required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  for (const field of definition.credentialSchema) {
    if (!shouldShowCredentialField(definition.type, field.name, config)) continue;
    const value = credentials[field.name];
    const required = isCredentialFieldRequired(definition.type, field.name, config, field.required);
    if (required && (value === undefined || value === null || value === '')) {
      errors.push(`${field.label} is required`);
    }
  }
  return errors;
}

async function getOptionalCreatorProfiles(
  authEnv: ReturnType<typeof getAuthEnv>,
  userIds: Iterable<string | null | undefined>,
  request: Request,
  preloadedUsers: Iterable<User | null | undefined>,
  label: string,
): Promise<Map<string, UserProfileSummary>> {
  try {
    return await loadUserProfileSummaries(authEnv, userIds, {
      request,
      preloadedUsers,
    });
  } catch (error) {
    console.error(`Failed to load ${label} creator profiles:`, error);
    return new Map();
  }
}

async function slackChannelMetadata(
  record: WorkspaceIntegrationRecord,
  config: Record<string, unknown>,
  env: CloudflareEnv,
): Promise<ConnectionListItem['channelMetadata']> {
  if (record.integration_type !== 'slack') return undefined;
  const fromConfig = {
    team_id: typeof config.team_id === 'string' ? config.team_id : null,
    team_name: typeof config.team_name === 'string' ? config.team_name : null,
    bot_user_id: typeof config.bot_user_id === 'string' ? config.bot_user_id : null,
  };
  if (fromConfig.team_id || fromConfig.team_name || fromConfig.bot_user_id) {
    return fromConfig;
  }
  if (!record.credentials_encrypted) return fromConfig;

  try {
    const credentials = await decryptCredentials<Record<string, unknown>>(
      record.credentials_encrypted,
      env.INTEGRATION_SECRET_KEY,
    );
    return {
      team_id: typeof credentials.team_id === 'string' ? credentials.team_id : null,
      team_name: typeof credentials.team_name === 'string' ? credentials.team_name : null,
      bot_user_id: typeof credentials.bot_user_id === 'string' ? credentials.bot_user_id : null,
    };
  } catch (error) {
    console.error('Failed to read Slack channel metadata:', error);
    return fromConfig;
  }
}

async function recordToIntegration(
  record: WorkspaceIntegrationRecord,
  creators: Map<string, UserProfileSummary>,
  env: CloudflareEnv,
): Promise<ConnectionListItem> {
  const config = parseIntegrationConfig(record.config);
  const creator = creators.get(record.created_by);
  return {
    id: record.id,
    integration_type: record.integration_type,
    name: record.name,
    category: record.category as Integration['category'],
    auth_method: record.auth_method as Integration['auth_method'],
    config,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
    has_credentials: Boolean(record.credentials_encrypted),
    auth_status: record.auth_status,
    auth_error_code: record.auth_error_code,
    auth_error_message: record.auth_error_message,
    auth_checked_at: record.auth_checked_at,
    reauth_required_at: record.reauth_required_at,
    token_expires_at: record.token_expires_at,
    created_by_name: creator ? creator.name || creator.email : null,
    created_by_avatar: creator?.avatar ?? null,
    channelMetadata: await slackChannelMetadata(record, config, env),
  };
}

function hasNonEmptyCredentialValue(credentials: Record<string, unknown>): boolean {
  return Object.values(credentials).some((value) => {
    if (value === null || value === undefined) return false;
    return String(value).trim().length > 0;
  });
}

export function meta() {
  return [
    { title: 'Connections - camelAI' },
    { name: 'description', content: 'Manage integrations and connections' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);

  const workspaceId = authContext.currentWorkspace?.id;
  if (!workspaceId) {
    return { error: 'No workspace selected' };
  }
  await requireWorkspaceAccess(request, context, workspaceId, 'full');

  const authEnv = getAuthEnv(env);
  const formData = await request.formData();
  const intent = formData.get('intent');

  if (typeof intent === 'string' && CONNECTION_MANAGEMENT_INTENTS.has(intent)) {
    const canManageConnections = await isOrgAdmin(
      getAuthEnv(env),
      authContext.user.id,
      authContext.currentOrg.id,
    );
    if (!canManageConnections) {
      return { error: 'Only organization admins can manage connections' };
    }
  }

  if (intent === 'createIntegration') {
    const integrationType = formData.get('integration_type') as string;
    const name = formData.get('name') as string;
    const configStr = formData.get('config') as string;
    const credentialsStr = formData.get('credentials') as string;

    if (!integrationType || !name) {
      return { error: 'Missing required fields' };
    }

    const definition = getIntegrationDefinition(integrationType);
    if (!definition) {
      return { error: `Unknown integration type: ${integrationType}` };
    }

    try {
      const config = configStr ? JSON.parse(configStr) : {};
      const credentials = credentialsStr ? JSON.parse(credentialsStr) : {};
      const validationErrors = validateRequiredIntegrationFields(definition, config, credentials);
      if (validationErrors.length > 0) {
        return { error: validationErrors.join(', ') };
      }
      if (integrationType === 'remote_mcp') {
        const validationErrors = validateRemoteMcpConnection(config, credentials);
        if (validationErrors.length > 0) {
          return { error: validationErrors.join(', ') };
        }
        config.server_url = normalizeRemoteMcpUrl(String(config.server_url));
      }
      if (integrationType === 'telegram') {
        const botUsername = normalizeTelegramBotUsername(env.TELEGRAM_BOT_USERNAME);
        if (!botUsername || !env.TELEGRAM_BOT_TOKEN?.trim()) {
          return { error: 'Telegram bot is not configured' };
        }
        if (!env.TELEGRAM_REGISTRY) {
          return { error: 'Telegram registry is not configured' };
        }

        const setupToken = generateTelegramSetupToken();
        const integrationId = crypto.randomUUID();
        const setupExpiresAt = Date.now() + TELEGRAM_SETUP_TTL_SECONDS * 1000;
        const telegramConfig = {
          ...config,
          status: 'pending',
          setup_token: setupToken,
          setup_expires_at: setupExpiresAt,
          bot_username: botUsername,
        };
        const credentialsEncrypted = await encryptCredentials(
          { shared_bot: true },
          env.INTEGRATION_SECRET_KEY,
        );

        await createWorkspaceIntegrationRecord(
          authEnv,
          workspaceId,
          integrationId,
          integrationType,
          name,
          definition.category,
          definition.authMethod,
          JSON.stringify(telegramConfig),
          credentialsEncrypted,
          authContext.user.id
        );

        const setupRecord: TelegramSetupRecord = {
          workspaceId,
          orgId: authContext.currentOrg.id,
          integrationId,
          userId: authContext.user.id,
        };
        const registry = env.TELEGRAM_REGISTRY.get(
          env.TELEGRAM_REGISTRY.idFromName(getTelegramRegistryName(botUsername)),
        );
        await registry.putSetupToken(
          setupToken,
          setupRecord,
          TELEGRAM_SETUP_TTL_SECONDS,
        );

        return {
          success: true,
          oauthUrl: buildTelegramDeepLink(botUsername, setupToken),
        };
      }
      const shouldStoreCredentials =
        integrationType === 'remote_mcp'
          ? hasNonEmptyCredentialValue(credentials)
          : shouldStoreIntegrationCredentials(integrationType, credentials);
      const credentialsEncrypted = shouldStoreCredentials
        ? await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY)
        : '';

      const integrationId = crypto.randomUUID();
        await createWorkspaceIntegrationRecord(
          authEnv,
          workspaceId,
          integrationId,
          integrationType,
          name,
        definition.category,
        definition.authMethod,
        JSON.stringify(config),
        credentialsEncrypted,
        authContext.user.id
      );
      if (integrationType === 'remote_mcp' && config.auth_type === 'oauth') {
        const params = new URLSearchParams({
          integration_id: integrationId,
          redirect: '/connections',
        });
        return { success: true, oauthUrl: `/api/integrations/remote_mcp/oauth?${params.toString()}` };
      }
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to create integration' };
    }
  }

  if (intent === 'updateIntegration') {
    const integrationId = formData.get('integrationId') as string;
    const name = formData.get('name') as string | null;
    const configStr = formData.get('config') as string | null;
    const credentialsStr = formData.get('credentials') as string | null;

    if (!integrationId) {
      return { error: 'Integration ID is required' };
    }

    try {
      const existing = await getWorkspaceIntegrationRecord(authEnv, workspaceId, integrationId);
      if (!existing) {
        return { error: 'Integration not found' };
      }

      const updates: {
        name?: string;
        config?: string;
        credentialsEncrypted?: string;
      } = {};

      if (name) updates.name = name;
      let parsedConfig: Record<string, unknown> | null = null;
      let parsedCredentials: Record<string, unknown> | null = null;
      if (configStr) {
        parsedConfig = JSON.parse(configStr) as Record<string, unknown>;
      }
      if (credentialsStr) {
        parsedCredentials = JSON.parse(credentialsStr) as Record<string, unknown>;
      }

      if (existing.integration_type === 'remote_mcp' && (parsedConfig || parsedCredentials)) {
        const validationConfig = parsedConfig ?? JSON.parse(existing.config) as Record<string, unknown>;
        const validationCredentials = parsedCredentials ?? (
          existing.credentials_encrypted
            ? await decryptCredentials<Record<string, unknown>>(
                existing.credentials_encrypted,
                env.INTEGRATION_SECRET_KEY
              )
            : {}
        );
        const validationErrors = validateRemoteMcpConnection(validationConfig, validationCredentials);
        if (validationErrors.length > 0) {
          return { error: validationErrors.join(', ') };
        }
        if (parsedConfig) {
          parsedConfig.server_url = normalizeRemoteMcpUrl(String(parsedConfig.server_url));
        }
      }

      if (parsedConfig) updates.config = JSON.stringify(parsedConfig);
      if (parsedCredentials) {
        const shouldStoreCredentials =
          existing.integration_type === 'remote_mcp'
            ? hasNonEmptyCredentialValue(parsedCredentials)
            : shouldStoreIntegrationCredentials(existing.integration_type, parsedCredentials);
        updates.credentialsEncrypted = shouldStoreCredentials
          ? await encryptCredentials(parsedCredentials, env.INTEGRATION_SECRET_KEY)
          : '';
      }

      await updateWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
        updates,
        authContext.user.id,
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to update integration' };
    }
  }

  if (intent === 'deleteIntegration') {
    const integrationId = formData.get('integrationId') as string;

    if (!integrationId) {
      return { error: 'Integration ID is required' };
    }

    try {
      await deleteWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
        authContext.user.id,
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to delete integration' };
    }
  }

  if (intent === 'duplicateIntegration') {
    const integrationId = formData.get('integrationId') as string;
    const targetWorkspaceId = formData.get('targetWorkspaceId') as string;

    if (!integrationId || !targetWorkspaceId) {
      return { error: 'Integration ID and target workspace are required' };
    }

    const targetInfo = authContext.workspaces?.find((ws) => ws.id === targetWorkspaceId);
    if (!targetInfo) {
      return { error: 'Target workspace must belong to the same organization' };
    }

    try {
      // Get the source integration record (including encrypted credentials)
      const sourceRecord = await getWorkspaceIntegrationRecord(
        authEnv,
        workspaceId,
        integrationId,
      );
      if (!sourceRecord) {
        return { error: 'Integration not found' };
      }

      // Deduplicate name: append " (copy)" if the name already exists on target
      let copyName = sourceRecord.name;
      const nameExists = await workspaceIntegrationNameExists(
        authEnv,
        targetWorkspaceId,
        sourceRecord.integration_type,
        copyName,
      );
      if (nameExists) {
        copyName = `${copyName} (copy)`;
      }

      // Copy to target workspace with new ID
      await createWorkspaceIntegrationRecord(
        authEnv,
        targetWorkspaceId,
        crypto.randomUUID(),
        sourceRecord.integration_type,
        copyName,
        sourceRecord.category,
        sourceRecord.auth_method,
        sourceRecord.config,
        sourceRecord.credentials_encrypted,
        authContext.user.id,
        sourceRecord.token_expires_at ?? null
      );

      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to duplicate integration' };
    }
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const workspaceId = authContext.currentWorkspace?.id;
  const workspace = authContext.currentWorkspace;

  // Get integration types
  const integrations = Object.values(INTEGRATION_REGISTRY);
  const categories = Array.from(
    new Set(integrations.map((i) => i.category))
  ) as string[];

  // Get workspace integrations
  const connectionsPromise: Promise<ConnectionListItem[]> = workspaceId
    ? listWorkspaceIntegrationRecords(authEnv, workspaceId)
        .then(async (records) => {
          const creators = await getOptionalCreatorProfiles(authEnv, [
            ...records.map((record) => record.created_by),
            workspace?.created_by ?? '',
          ], request, [authContext.user], 'workspace connection');
          return Promise.all(
            records.map((record) => recordToIntegration(record, creators, env)),
          );
        })
        .catch((error) => {
          console.error('Failed to load workspace connections:', error);
          return [];
        })
    : Promise.resolve([]);
  const projectsPromise: Promise<MentionableProject[]> = workspaceId
    ? loadWorkspaceMentionProjects(env, workspaceId).catch((error) => {
        console.error('Failed to load workspace projects:', error);
        return [];
      })
    : Promise.resolve([]);
  // Promises passed to <Await> must be created here in the loader, never inline
  // in render: a suspended revalidation transition recreates render-scoped
  // promises on every retry and never commits.
  const pageDataPromise = Promise.all([connectionsPromise, projectsPromise]).then(
    ([connections, projects]) => ({ connections, projects }),
  );

  // Get other workspaces in the org for duplication targets
  const otherWorkspaces = (authContext.workspaces ?? [])
    .filter((ws) => ws.id !== workspaceId)
    .map((ws) => ({ id: ws.id, name: ws.name }));
  const workspaceEmailDomain = getWorkspaceEmailDomain(env);
  const workspaceEmailAddress = workspace?.email_handle && workspaceEmailDomain
    ? buildWorkspaceEmailAddress(workspace.email_handle, workspaceEmailDomain)
    : null;
  const emailInboxEnabled = getBillingPlanLimits(
    authContext.currentOrg.billing_plan,
    authContext.currentOrg.billing_status,
  ).emailInbox;
  const workspaceCreator = workspace?.created_by
    ? (await getOptionalCreatorProfiles(
        authEnv,
        [workspace.created_by],
        request,
        [authContext.user],
        'workspace email',
      )).get(workspace.created_by)
    : null;

  return {
    pageData: pageDataPromise,
    integrations,
    categories,
    orgId: authContext.currentOrg.id,
    workspaceId: workspaceId ?? null,
    otherWorkspaces,
    workspaceEmailAddress,
    emailMentionSlug: null,
    emailInboxEnabled,
    emailHandle: workspace?.email_handle ?? null,
    workspaceCreatedBy: workspace?.created_by ?? null,
    workspaceCreatedByName: workspaceCreator?.name ?? null,
    workspaceCreatedByAvatar: workspaceCreator?.avatar ?? null,
    workspaceCreatedAt: workspace?.created_at ?? null,
  };
}

export default function ConnectionsPage() {
  const {
    pageData,
    integrations,
    categories,
    workspaceId,
    otherWorkspaces,
    workspaceEmailAddress,
    emailMentionSlug,
    emailInboxEnabled,
    emailHandle,
    workspaceCreatedBy,
    workspaceCreatedByName,
    workspaceCreatedByAvatar,
    workspaceCreatedAt,
  } =
    useLoaderData<typeof loader>();

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <Suspense fallback={<ConnectionsLoadingSkeleton />}>
      <Await resolve={pageData}>
        {({ connections, projects }) => (
          <ConnectionsClient
            key={workspaceId}
            initialConnections={connections}
            initialMentionProjects={projects}
            connectionTypes={integrations}
            categories={categories}
            workspaceId={workspaceId}
            otherWorkspaces={otherWorkspaces}
            workspaceEmailAddress={workspaceEmailAddress}
            emailMentionSlug={emailMentionSlug}
            emailInboxEnabled={emailInboxEnabled}
            emailHandle={emailHandle}
            workspaceCreatedBy={workspaceCreatedBy}
            workspaceCreatedByName={workspaceCreatedByName}
            workspaceCreatedByAvatar={workspaceCreatedByAvatar}
            workspaceCreatedAt={workspaceCreatedAt}
          />
        )}
      </Await>
    </Suspense>
  );
}

export function HydrateFallback() {
  return <ConnectionsLoadingSkeleton />;
}
