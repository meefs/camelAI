import { useLoaderData } from 'react-router';
import type { Route } from './+types/_app.settings.workspace.general';
import { requireAuthContext } from '@/lib/auth.server';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { WorkspaceGeneralForm } from '@/components/settings/workspace-general-form';

export function meta() {
  return [
    { title: 'Workspace General - Settings - Chiridion' },
    { name: 'description', content: 'Manage workspace settings' },
  ];
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  return {
    workspace: authContext.currentWorkspace,
  };
}

export default function WorkspaceGeneralPage() {
  const { workspace } = useLoaderData<typeof loader>();

  if (!workspace) {
    return (
      <div className="space-y-6">
        <SettingsHeader
          title="Workspace"
          description="No workspace selected."
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <SettingsHeader
        title="Workspace"
        description="Manage your workspace settings."
      />
      <Separator />
      <WorkspaceGeneralForm workspace={workspace} canEdit={true} />
    </div>
  );
}
