import { waitUntil } from 'cloudflare:workers';
import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.connections';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { isOrgMember } from '@/lib/auth-do';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { INTEGRATION_REGISTRY, getIntegrationDefinition } from '@/lib/integration-registry';
import { encryptCredentials } from '@/lib/integration-crypto';
import type { WorkspaceDO } from '../../workers/main/src/workspace';
import { getWorkspaceContainer, type WorkspaceContainerEnv } from '../../workers/main/src/workspace-container';
import ConnectionsClient from '@/components/pages/connections/connections-client';
import { ConnectionsLoadingSkeleton } from '@/components/pages/connections/connections-loading';
import { NoWorkspacesError } from '@/components/no-workspaces-error';
import type { Integration } from '@/types';

function getWorkspaceStub(env: CloudflareEnv, workspaceId: string): WorkspaceDO {
  return env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId)) as unknown as WorkspaceDO;
}

function recordToIntegration(record: {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string;
  credentials_encrypted: string;
  enabled: number;
  created_by: string;
  created_at: number;
  updated_at: number;
}): Integration {
  return {
    id: record.id,
    integration_type: record.integration_type,
    name: record.name,
    category: record.category as Integration['category'],
    auth_method: record.auth_method as Integration['auth_method'],
    config: JSON.parse(record.config) as Record<string, unknown>,
    enabled: record.enabled === 1,
    created_by: record.created_by,
    created_at: record.created_at,
    updated_at: record.updated_at,
    has_credentials: Boolean(record.credentials_encrypted),
  };
}

export function meta() {
  return [
    { title: 'Connections - Chiridion' },
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

  const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
  const formData = await request.formData();
  const intent = formData.get('intent');

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
      const credentialsEncrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);

      await stub.createIntegration(
        crypto.randomUUID(),
        integrationType,
        name,
        definition.category,
        definition.authMethod,
        JSON.stringify(config),
        credentialsEncrypted,
        authContext.user.id
      );
      // Push updated env vars to running container (background, kept alive via waitUntil)
      waitUntil(
        getWorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId)
          .refreshIntegrationEnvVars(workspaceId)
          .catch(() => {})
      );
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
      const updates: {
        name?: string;
        config?: string;
        credentialsEncrypted?: string;
        enabled?: boolean;
      } = {};

      if (name) updates.name = name;
      if (configStr) updates.config = configStr;
      if (credentialsStr) {
        const credentials = JSON.parse(credentialsStr);
        updates.credentialsEncrypted = await encryptCredentials(credentials, env.INTEGRATION_SECRET_KEY);
      }

      await stub.updateIntegration(integrationId, updates, authContext.user.id);
      // Push updated env vars to running container (background, kept alive via waitUntil)
      waitUntil(
        getWorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId)
          .refreshIntegrationEnvVars(workspaceId)
          .catch(() => {})
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to update integration' };
    }
  }

  if (intent === 'toggleIntegration') {
    const integrationId = formData.get('integrationId') as string;
    const enabled = formData.get('enabled') === 'true';

    if (!integrationId) {
      return { error: 'Integration ID is required' };
    }

    try {
      await stub.updateIntegration(integrationId, { enabled }, authContext.user.id);
      // Push updated env vars to running container (background, kept alive via waitUntil)
      waitUntil(
        getWorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId)
          .refreshIntegrationEnvVars(workspaceId)
          .catch(() => {})
      );
      return { success: true };
    } catch (err) {
      return { error: err instanceof Error ? err.message : 'Failed to toggle integration' };
    }
  }

  if (intent === 'deleteIntegration') {
    const integrationId = formData.get('integrationId') as string;

    if (!integrationId) {
      return { error: 'Integration ID is required' };
    }

    try {
      await stub.deleteIntegration(integrationId, authContext.user.id);
      // Push updated env vars to running container (background, kept alive via waitUntil)
      waitUntil(
        getWorkspaceContainer(env as unknown as WorkspaceContainerEnv, workspaceId)
          .refreshIntegrationEnvVars(workspaceId)
          .catch(() => {})
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

    // Verify target workspace belongs to the same org
    const authEnv = getAuthEnv(env);
    const targetStub = env.WORKSPACE.get(env.WORKSPACE.idFromName(targetWorkspaceId));
    const targetInfo = await targetStub.getInfo();
    if (!targetInfo || targetInfo.org_id !== authContext.currentOrg.id) {
      return { error: 'Target workspace must belong to the same organization' };
    }

    // Verify user has access to target workspace
    const isMember = await isOrgMember(authEnv, authContext.user.id, targetInfo.org_id);
    if (!isMember) {
      return { error: 'You do not have access to the target workspace' };
    }

    try {
      // Get the source integration record (including encrypted credentials)
      const sourceRecord = await stub.getIntegration(integrationId);
      if (!sourceRecord) {
        return { error: 'Integration not found' };
      }

      // Copy to target workspace with new ID
      await targetStub.createIntegration(
        crypto.randomUUID(),
        sourceRecord.integration_type,
        sourceRecord.name,
        sourceRecord.category,
        sourceRecord.auth_method,
        sourceRecord.config,
        sourceRecord.credentials_encrypted,
        authContext.user.id,
        sourceRecord.token_expires_at ?? null
      );

      // Push updated env vars to target workspace container
      waitUntil(
        getWorkspaceContainer(env as unknown as WorkspaceContainerEnv, targetWorkspaceId)
          .refreshIntegrationEnvVars(targetWorkspaceId)
          .catch(() => {})
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
  const workspaceId = authContext.currentWorkspace?.id;

  // Get integration types
  const integrations = Object.values(INTEGRATION_REGISTRY);
  const categories = Array.from(
    new Set(integrations.map((i) => i.category))
  ) as string[];

  // Get workspace integrations
  let connections: Integration[] = [];
  if (workspaceId) {
    const stub = env.WORKSPACE.get(env.WORKSPACE.idFromName(workspaceId));
    const records = await stub.getIntegrations();
    connections = records.map(recordToIntegration);
  }

  // Get other workspaces in the org for duplication targets
  const otherWorkspaces = (authContext.workspaces ?? [])
    .filter((ws) => ws.id !== workspaceId)
    .map((ws) => ({ id: ws.id, name: ws.name }));

  return {
    connections,
    integrations,
    categories,
    orgId: authContext.currentOrg.id,
    workspaceId: workspaceId ?? null,
    otherWorkspaces,
  };
}

export default function ConnectionsPage() {
  const { connections, integrations, categories, orgId, workspaceId, otherWorkspaces } =
    useLoaderData<typeof loader>();

  if (!workspaceId) {
    return <NoWorkspacesError />;
  }

  return (
    <ConnectionsClient
      initialConnections={connections}
      connectionTypes={integrations}
      categories={categories}
      orgId={orgId}
      otherWorkspaces={otherWorkspaces}
    />
  );
}

export function HydrateFallback() {
  return <ConnectionsLoadingSkeleton />;
}
