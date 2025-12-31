import { redirect } from 'next/navigation';
import { getSessionId } from '@/lib/auth';
import * as authDO from '@/lib/auth-do';
import ComputerPageContent from './computer-page-content';

interface PageProps {
  params: Promise<{ orgId: string }>;
}

export default async function ComputerPage({ params }: PageProps) {
  const { orgId } = await params;
  const sessionId = await getSessionId();
  if (!sessionId) {
    redirect('/login');
  }

  const session = await authDO.getSession(sessionId);
  if (!session) {
    redirect('/login');
  }

  if (session.org_id !== orgId) {
    redirect(`/computer/${session.org_id}`);
  }

  return <ComputerPageContent orgId={orgId} />;
}
