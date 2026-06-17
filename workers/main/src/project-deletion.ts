import type { WorkspaceProject } from "./workspace-filesystem-do";

export function orderProjectsForRuntimeDelete(
  projects: Array<{ id: string; clonedFromProjectId?: string }>,
): string[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const depthById = new Map<string, number>();
  const depth = (project: { id: string; clonedFromProjectId?: string }): number => {
    const cached = depthById.get(project.id);
    if (cached !== undefined) return cached;
    const source = project.clonedFromProjectId ? byId.get(project.clonedFromProjectId) : undefined;
    const value = source ? depth(source) + 1 : 0;
    depthById.set(project.id, value);
    return value;
  };
  return Array.from(new Map(projects.map((project) => [project.id, project])).values())
    .sort((a, b) => depth(b) - depth(a) || a.id.localeCompare(b.id))
    .map((project) => project.id);
}

export function collectProjectDeletionTargets(
  projects: WorkspaceProject[],
  target: WorkspaceProject,
): WorkspaceProject[] {
  if (target.clonedFromProjectId) {
    return [target];
  }
  const descendants = projects.filter(
    (project) =>
      project.clonedFromProjectId === target.id ||
      project.artifactRemoteProjectId === target.id,
  );
  return [target, ...descendants];
}
