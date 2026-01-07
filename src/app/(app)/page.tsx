import Chat from '@/components/Chat';
import { requireSession } from '@/lib/server-guards';

export default async function Home() {
  const session = await requireSession();
  if (!session.workspace_id) {
    return null;
  }
  return <Chat workspaceId={session.workspace_id} />;
}
