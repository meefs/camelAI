import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.computer.$workspaceId';
import { requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import {
  getWorkspaceContainer,
  type WorkspaceContainerEnv,
} from '../../workers/main/src/workspace-container';
import ComputerPageContent from '@/components/pages/computer/computer-page-content';

export function meta() {
  return [
    { title: 'Computer - Chiridion' },
    { name: 'description', content: 'Interactive workspace file browser' },
  ];
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = params.workspaceId;

  if (!authContext.currentWorkspace?.id || authContext.currentWorkspace.id !== workspaceId) {
    return { success: false, error: 'Unauthorized' };
  }

  const formData = await request.formData();
  const intent = formData.get('intent');

  if (intent === 'reset-container') {
    try {
      const env = getEnv(context);
      const containerEnv = env as unknown as WorkspaceContainerEnv;
      const container = getWorkspaceContainer(containerEnv, workspaceId);
      await container.destroy();
      return { success: true };
    } catch (error) {
      console.error('Failed to reset container:', error);
      return { success: false, error: 'Failed to reset container' };
    }
  }

  return { success: false, error: 'Unknown intent' };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = params.workspaceId;

  if (!authContext.currentWorkspace?.id) {
    throw redirect('/computer');
  }

  if (authContext.currentWorkspace.id !== workspaceId) {
    throw redirect(`/computer/${authContext.currentWorkspace.id}`);
  }

  return { workspaceId };
}

export default function ComputerPage() {
  const { workspaceId } = useLoaderData<typeof loader>();
  return <ComputerPageContent workspaceId={workspaceId} />;
}
