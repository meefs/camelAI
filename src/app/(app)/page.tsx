import Chat from '@/components/Chat';
import { requireSession } from '@/lib/server-guards';

export default async function Home() {
  const session = await requireSession();
  return <Chat orgId={session.org_id} />;
}
