import { redirect } from 'next/navigation';
import { requireSession } from '@/lib/server-guards';
import ComputerPageContent from './computer-page-content';

interface PageProps {
  params: Promise<{ orgId: string }>;
}

export default async function ComputerPage({ params }: PageProps) {
  const { orgId } = await params;
  const session = await requireSession();

  if (session.org_id !== orgId) {
    redirect(`/computer/${session.org_id}`);
  }

  return <ComputerPageContent orgId={orgId} />;
}
