import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/server-guards';

export default async function ComputerRootPage() {
  const session = await requireSession();
  if (!session.workspace_id) {
    redirect('/');
  }
  redirect(`/computer/${session.workspace_id}`);
}
