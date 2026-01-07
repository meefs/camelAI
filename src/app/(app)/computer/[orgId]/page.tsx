import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/server-guards';
import ComputerPageContent from './computer-page-content';

interface PageProps {
  params: Promise<{ orgId: string }>;
}

export default async function ComputerPage({ params }: PageProps) {
  const { orgId: workspaceId } = await params;
  const session = await requireSession();

  if (!session.workspace_id) {
    redirect('/computer');
  }

  if (session.workspace_id !== workspaceId) {
    redirect(`/computer/${session.workspace_id}`);
  }

  return <ComputerPageContent workspaceId={workspaceId} />;
}
