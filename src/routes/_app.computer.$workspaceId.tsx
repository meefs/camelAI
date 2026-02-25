import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.computer.$workspaceId';
import { getAuthEnv, requireAuthContext } from '@/lib/auth.server';
import { getEnv } from '@/lib/cloudflare.server';
import { getWorkspace } from '@/lib/auth-do';
import ComputerPageContent from '@/components/pages/computer/computer-page-content';

export function meta() {
  return [
    { title: 'Computer - camelAI' },
    { name: 'description', content: 'Interactive workspace file browser' },
  ];
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);
  const workspaceId = params.workspaceId;
  const url = new URL(request.url);
  const isAdminReadonly = url.searchParams.get('adminReadonly') === '1';

  if (!workspaceId) {
    throw redirect('/computer');
  }

  if (authContext.currentWorkspace?.id === workspaceId) {
    return { workspaceId };
  }

  if (isAdminReadonly && authContext.user.is_superuser) {
    const authEnv = getAuthEnv(getEnv(context));
    const workspace = await getWorkspace(authEnv, workspaceId);
    if (workspace) {
      return { workspaceId };
    }
  }

  if (!authContext.currentWorkspace?.id) {
    throw redirect('/computer');
  }

  throw redirect(`/computer/${authContext.currentWorkspace.id}`);
}

export default function ComputerPage() {
  const { workspaceId } = useLoaderData<typeof loader>();
  return <ComputerPageContent workspaceId={workspaceId} />;
}
