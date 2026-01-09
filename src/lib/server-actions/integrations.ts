"use server";

import * as authDO from "@/lib/auth-do";
import {
  getAllCategories,
  getAllIntegrations,
  getIntegrationsByCategory,
  getIntegrationDefinition,
  validateConfig,
  validateCredentials,
} from "@/lib/integration-registry";
import { requireSession } from "@/lib/server-guards";
import type { Integration, IntegrationCategory } from "@/types";

export async function getIntegrationTypes(category?: IntegrationCategory | null) {
  if (category) {
    return { integrations: getIntegrationsByCategory(category) };
  }
  return {
    integrations: getAllIntegrations(),
    categories: getAllCategories(),
  };
}

async function requireWorkspaceAccess(workspaceId: string) {
  const session = await requireSession();
  const workspace = await authDO.getWorkspace(workspaceId);
  if (!workspace || workspace.org_id !== session.org_id) {
    throw new Error("Workspace not found");
  }
  const access = await authDO.getWorkspaceAccess(workspaceId, session.user_id);
  if (access === "none") {
    throw new Error("Workspace not found");
  }
  return { session, workspace, access };
}

export async function getWorkspaceIntegrations(workspaceId: string): Promise<Integration[]> {
  await requireWorkspaceAccess(workspaceId);
  return authDO.getWorkspaceIntegrations(workspaceId);
}

export async function getWorkspaceIntegration(
  workspaceId: string,
  integrationId: string
): Promise<Integration | null> {
  await requireWorkspaceAccess(workspaceId);
  return authDO.getWorkspaceIntegration(workspaceId, integrationId);
}

export async function createWorkspaceIntegration(
  workspaceId: string,
  data: {
    integration_type: string;
    name: string;
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
  }
): Promise<Integration> {
  const { session } = await requireWorkspaceAccess(workspaceId);

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
  if (!isAdmin) {
    throw new Error("Only admins can create integrations");
  }

  const definition = getIntegrationDefinition(data.integration_type);
  if (!definition) {
    throw new Error(`Unknown integration type: ${data.integration_type}`);
  }

  const name = data.name?.trim() ?? "";
  if (!name) {
    throw new Error("Integration name is required");
  }
  if (name.length > 100) {
    throw new Error("Integration name must be 100 characters or less");
  }

  const config = data.config ?? {};
  const credentials = data.credentials ?? {};
  const configErrors = validateConfig(data.integration_type, config);
  if (configErrors.length > 0) {
    throw new Error(configErrors.join(", "));
  }
  const credentialErrors = validateCredentials(data.integration_type, credentials);
  if (credentialErrors.length > 0) {
    throw new Error(credentialErrors.join(", "));
  }

  return authDO.createWorkspaceIntegration(workspaceId, session.user_id, {
    integration_type: data.integration_type,
    name,
    config,
    credentials,
  });
}

export async function updateWorkspaceIntegration(
  workspaceId: string,
  integrationId: string,
  data: {
    name?: string;
    config?: Record<string, unknown>;
    credentials?: Record<string, unknown>;
    enabled?: boolean;
  }
): Promise<Integration | null> {
  const { session } = await requireWorkspaceAccess(workspaceId);

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
  if (!isAdmin) {
    throw new Error("Only admins can update integrations");
  }

  const existing = await authDO.getWorkspaceIntegration(workspaceId, integrationId);
  if (!existing) {
    throw new Error("Integration not found");
  }

  if (data.name !== undefined) {
    const name = data.name.trim();
    if (!name) {
      throw new Error("Integration name is required");
    }
    if (name.length > 100) {
      throw new Error("Integration name must be 100 characters or less");
    }
  }

  if (data.config) {
    const configErrors = validateConfig(existing.integration_type, data.config);
    if (configErrors.length > 0) {
      throw new Error(configErrors.join(", "));
    }
  }

  if (data.credentials) {
    const credentialErrors = validateCredentials(existing.integration_type, data.credentials);
    if (credentialErrors.length > 0) {
      throw new Error(credentialErrors.join(", "));
    }
  }

  return authDO.updateWorkspaceIntegration(workspaceId, integrationId, session.user_id, {
    name: data.name?.trim(),
    config: data.config,
    credentials: data.credentials,
    enabled: data.enabled,
  });
}

export async function deleteWorkspaceIntegration(
  workspaceId: string,
  integrationId: string
): Promise<{ success: boolean }> {
  const { session } = await requireWorkspaceAccess(workspaceId);

  const isAdmin = await authDO.isOrgAdmin(session.user_id, session.org_id);
  if (!isAdmin) {
    throw new Error("Only admins can delete integrations");
  }

  await authDO.deleteWorkspaceIntegration(workspaceId, integrationId, session.user_id);
  return { success: true };
}
