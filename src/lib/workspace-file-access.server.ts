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

  let superuser: boolean | null = null;
  const isSuperuser = async (): Promise<boolean> => {
    if (superuser !== null) return superuser;
    const userProfile = await authEnv.USER.get(authEnv.USER.idFromName(userId)).getProfile();
    superuser = Boolean(userProfile?.is_superuser);
    return superuser;
  };

  if (workspace.org_id === sessionOrgId) {
    const access = await getWorkspaceAccess(authEnv, workspaceId, userId);
    if (access !== 'none') {
      return workspace.org_id;
    }
    return (await isSuperuser()) ? workspace.org_id : null;
  }

  if (!(await isSuperuser())) {
    return null;
  }

  return workspace.org_id;
}
