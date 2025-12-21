import Chat from '@/components/Chat';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  return <Chat threadId={id} />;
}
