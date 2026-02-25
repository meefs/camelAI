import type { AuthEnv } from '@/lib/auth-helpers';
import { getWorkspace, getWorkspaceAccess } from '@/lib/auth-do';

export async function resolveWorkspaceFileReadOrgId(
  authEnv: AuthEnv,
  workspaceId: string,
  sessionOrgId: string,
  userId: string
): Promise<string | null> {
  const workspace = await getWorkspace(authEnv, workspaceId);
  if (!workspace) return null;

  if (workspace.org_id === sessionOrgId) {
    const access = await getWorkspaceAccess(authEnv, workspaceId, userId);
    if (access === 'none') {
      return null;
    }
    return workspace.org_id;
  }

  const userProfile = await authEnv.USER.get(authEnv.USER.idFromName(userId)).getProfile();
  if (!userProfile?.is_superuser) {
    return null;
  }

  return workspace.org_id;
}
