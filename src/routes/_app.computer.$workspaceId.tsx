import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.computer.$workspaceId';
import { requireAuthContext } from '@/lib/auth.server';
import ComputerPageContent from '@/components/pages/computer/computer-page-content';

export function meta() {
  return [
    { title: 'Computer - Chiridion' },
    { name: 'description', content: 'Interactive workspace file browser' },
  ];
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
