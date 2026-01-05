import Chat from '@/components/Chat';
import { requireSession } from '@/lib/server-guards';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  const session = await requireSession();
  return <Chat threadId={id} orgId={session.org_id} />;
}
