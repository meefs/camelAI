import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.organization.workspaces';
import { requireAuthContext } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { WorkspacesList } from '@/components/settings/workspaces-list';

export function meta() {
  return [
    { title: 'Workspaces - Settings - Chiridion' },
    { name: 'description', content: 'Manage workspaces' },
  ];
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
