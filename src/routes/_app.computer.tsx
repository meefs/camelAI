import { redirect, useLoaderData } from 'react-router';
import type { Route } from './+types/_app.computer';
import { requireAuthContext } from '@/lib/auth.server';
import { NoWorkspacesError } from '@/components/no-workspaces-error';

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    // Return indicator that there's no workspace, don't redirect
    return { hasWorkspace: false };
  }

  throw redirect(`/computer/${authContext.currentWorkspace.id}`);
}

export default function ComputerRootPage() {
  const data = useLoaderData<typeof loader>();

  // If we reach here, it means there's no workspace (otherwise we'd have redirected)
  if (!data.hasWorkspace) {
    return <NoWorkspacesError />;
  }

  return null;
}
