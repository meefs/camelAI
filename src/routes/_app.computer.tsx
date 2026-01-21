import { redirect } from 'react-router';
import type { Route } from './+types/_app.computer';
import { requireAuthContext } from '@/lib/auth.server';

export async function loader({ request, context }: Route.LoaderArgs) {
  const authContext = await requireAuthContext(request, context);

  if (!authContext.currentWorkspace?.id) {
    throw redirect('/');
  }

  throw redirect(`/computer/${authContext.currentWorkspace.id}`);
}

export default function ComputerRootPage() {
  // This component won't actually render due to the redirect
  return null;
}
