import HistoryClient from './history-client';
import { requireAuthContextLite } from '@/lib/server-guards';
import { getThreadsPage } from '@/lib/server-actions/thread';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function HistoryPage() {
  const authContext = await requireAuthContextLite();

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
