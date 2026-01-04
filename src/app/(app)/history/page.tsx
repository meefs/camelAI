import { redirect } from 'next/navigation';
import HistoryClient from './history-client';
import { getAuthContext } from '@/lib/auth-context';
import { getThreads } from '@/lib/server-actions/thread';

export const dynamic = 'force-dynamic';

export default async function HistoryPage() {
  const authContext = await getAuthContext();
  if (!authContext) {
    redirect('/login');
  }

  const threads = await getThreads();

  return (
    <HistoryClient
      initialThreads={threads}
      initialOrgId={authContext.currentOrg.id}
    />
  );
}
