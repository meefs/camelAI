import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.workspaces';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { WorkspacesList } from '@/components/settings/workspaces-list';

export function meta() {
  return [
    { title: 'Workspaces - Settings - Chiridion' },
    { name: 'description', content: 'Manage workspaces' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const intent = formData.get('intent');
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const orgId = authContext.currentOrg!.id;
  const actorId = authContext.user!.id;

  if (intent === 'createWorkspace') {
    const name = formData.get('name') as string;
    const description = formData.get('description') as string;
    if (!name?.trim()) {
      return { error: 'Workspace name is required' };
    }
    await authDO.createWorkspace(authEnv, orgId, name.trim(), actorId, description?.trim() || null);
    return { success: true };
  }

  if (intent === 'archiveWorkspace') {
    const workspaceId = formData.get('workspaceId') as string;
    if (!workspaceId) {
      return { error: 'Workspace ID is required' };
    }
    await authDO.archiveWorkspace(authEnv, workspaceId, actorId);
    return { success: true };
  }

  return { error: 'Unknown action' };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  return {
    org: authContext.currentOrg,
    workspaces: authContext.workspaces,
    currentWorkspaceId: authContext.currentWorkspace?.id,
  };
}

export default function WorkspacesPage() {
  const { org, workspaces, currentWorkspaceId } =
    useLoaderData<typeof loader>();

  // TODO: Calculate based on user's role
  const canManage = true;

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Workspaces"
        description="Manage workspaces in your organization."
      />
      <Separator />
      <WorkspacesList
        workspaces={workspaces as never[]}
        canManage={canManage}
        currentWorkspaceId={currentWorkspaceId ?? null}
      />
    </div>
  );
}
