import { Suspense } from 'react';
import { ChatLoading } from '@/components/chat-loading';
import HomeContent from './page-content';

export default function Home() {
  return (
    <Suspense fallback={<ChatLoading />}>
      <HomeContent />
    </Suspense>
  );
}
