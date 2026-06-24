import type { CopyFilePathTarget } from '@/lib/file-path-copy';

export function copyTargetFromToolInput(
  input: Record<string, unknown>,
  path: string,
): CopyFilePathTarget {
  const location = typeof input.location === 'string' ? input.location : undefined;
  const project = typeof input.project === 'string' ? input.project : undefined;
  const projectId =
    typeof input.projectId === 'string'
      ? input.projectId
      : typeof input.project_id === 'string'
        ? input.project_id
        : undefined;

  return {
    path,
    source: location,
    project,
    projectId,
  };
}
