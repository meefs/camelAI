import { Suspense } from 'react';
import { ChatLoading } from '@/components/chat-loading';
import ChatPageContent from './chat-page-content';

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function ChatPage({ params }: PageProps) {
  const { id } = await params;
  return (
    <Suspense fallback={<ChatLoading />}>
      <ChatPageContent threadId={id} />
    </Suspense>
  );
}
