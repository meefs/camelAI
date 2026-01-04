import { redirect } from 'next/navigation';
import HistoryClient from './history-client';
import { getAuthContextLite } from '@/lib/auth-context';
import { getThreadsPage } from '@/lib/server-actions/thread';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function HistoryPage() {
  const authContext = await getAuthContextLite();
  if (!authContext) {
    redirect('/login');
  }

  const page = await getThreadsPage({ offset: 0, limit: PAGE_SIZE });

  return (
    <HistoryClient
      initialThreads={page.items}
      initialTotal={page.total}
      initialOffset={page.offset}
      initialLimit={page.limit}
      initialOrgId={authContext.currentOrg.id}
    />
  );
}
