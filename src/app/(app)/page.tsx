import { headers } from 'next/headers';
import Chat from '@/components/Chat';
import { requireSession } from '@/lib/server-guards';

export default async function Home() {
  const session = await requireSession();
  if (!session.workspace_id) {
    return null;
  }
  const headerStore = await headers();
  const hostname = headerStore.get('host')?.split(':')[0];
  return <Chat workspaceId={session.workspace_id} hostname={hostname} />;
}
