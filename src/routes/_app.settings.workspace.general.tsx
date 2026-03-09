import { useLoaderData } from 'react-router';
import { parseWithZod } from '@conform-to/zod/v4';
import type { Route } from './+types/_app.settings.workspace.general';
import { requireAuthContext, getAuthEnv } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import * as authDO from '@/lib/auth-do';
import { buildWorkspaceEmailAddress, getWorkspaceEmailRoutingConfig } from '@/lib/workspace-email';
import { Separator } from '@/components/ui/separator';
import { SettingsHeader } from '@/components/settings/settings-header';
import { WorkspaceGeneralForm } from '@/components/settings/workspace-general-form';
import { workspaceSchema } from '@/lib/schemas';

export function meta() {
  return [
    { title: 'Workspace General - Settings - camelAI' },
    { name: 'description', content: 'Manage workspace settings' },
  ];
}

export async function action({ request, context }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const formData = await request.formData();
  const env = getEnv(context);
  const authEnv = getAuthEnv(env);
  const workspaceId = authContext.currentWorkspace?.id;
  const actorId = authContext.user!.id;

  if (!workspaceId) {
    return { error: 'No workspace selected' };
  }

  const submission = parseWithZod(formData, { schema: workspaceSchema });

  if (submission.status !== 'success') {
    return { result: submission.reply() };
  }

  const { name, description, avatarColor, avatarContent } = submission.value;

  const updates: { name?: string; description?: string | null; avatar?: { color: string; content: string } } = {
    name: name.trim(),
    description: description?.trim() || null,
  };

  if (avatarColor && avatarContent) {
    updates.avatar = { color: avatarColor, content: avatarContent };
  }

  try {
    await authDO.updateWorkspace(authEnv, workspaceId, updates, actorId);
  } catch (err) {
    if (err instanceof Error && err.message.includes('already exists')) {
      return { result: submission.reply({ fieldErrors: { name: ['A workspace with that name already exists in this organization'] } }) };
    }
    throw err;
  }
  return { result: submission.reply(), success: true };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const env = getEnv(context);

  const workspace = authContext.currentWorkspace;
  const routingConfig = getWorkspaceEmailRoutingConfig(env);
  const workspaceEmailAddress = workspace?.email_handle && routingConfig
    ? buildWorkspaceEmailAddress(workspace.email_handle, routingConfig.domain)
    : null;

  return {
    workspace,
    workspaceEmailAddress,
  };
}

export default function WorkspaceGeneralPage() {
  const { workspace, workspaceEmailAddress } = useLoaderData<typeof loader>();

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
      <WorkspaceGeneralForm
        workspace={workspace}
        workspaceEmailAddress={workspaceEmailAddress}
        canEdit={true}
      />
    </div>
  );
}
