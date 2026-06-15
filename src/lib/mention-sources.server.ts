import type { CloudflareEnv } from "@/lib/cloudflare.server";
import {
  getAuthEnv,
  integrationRecordToIntegration,
  type AuthEnv,
} from "@/lib/auth-helpers";
import { listWorkspaceIntegrationRecords } from "@/lib/auth-do";
import { projectsToMentionables, type MentionableProject } from "@/lib/mentions";
import type { Integration } from "@/types";

export interface WorkspaceMentionSources {
  connections: Integration[];
  projects: MentionableProject[];
}

export type WorkspaceMentionSourcesPatch = Partial<WorkspaceMentionSources> & {
  error?: string;
};

export async function loadWorkspaceMentionConnections(
  authEnv: AuthEnv,
  workspaceId: string,
): Promise<Integration[]> {
  const records = await listWorkspaceIntegrationRecords(authEnv, workspaceId);
  return records.map(integrationRecordToIntegration);
}

export async function loadWorkspaceMentionProjects(
  env: CloudflareEnv,
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

export async function loadWorkspaceMentionSources(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<WorkspaceMentionSources> {
  const patch = await loadWorkspaceMentionSourcesPatch(env, workspaceId);

  return {
    connections: patch.connections ?? [],
    projects: patch.projects ?? [],
  };
}

export async function loadWorkspaceMentionSourcesPatch(
  env: CloudflareEnv,
  workspaceId: string,
): Promise<WorkspaceMentionSourcesPatch> {
  const authEnv = getAuthEnv(env);
  const [connectionsResult, projectsResult] = await Promise.allSettled([
    loadWorkspaceMentionConnections(authEnv, workspaceId),
    loadWorkspaceMentionProjects(env, workspaceId),
  ]);

  const patch: WorkspaceMentionSourcesPatch = {};
  if (connectionsResult.status === "fulfilled") {
    patch.connections = connectionsResult.value;
  } else {
    console.error(
      "Failed to load workspace mention connections:",
      connectionsResult.reason,
    );
  }

  if (projectsResult.status === "fulfilled") {
    patch.projects = projectsResult.value;
  } else {
    console.error(
      "Failed to load workspace mention projects:",
      projectsResult.reason,
    );
  }

  if (!patch.connections || !patch.projects) {
    patch.error = "Failed to load one or more workspace mention sources";
  }

  return patch;
}
