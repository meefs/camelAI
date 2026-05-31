export function isCurrentWorkspacePendingAction(
  pendingWorkspaceId: string,
  currentWorkspaceId: string,
): boolean {
  return pendingWorkspaceId === currentWorkspaceId;
}
