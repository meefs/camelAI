'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';

export default function ChatError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const router = useRouter();

  useEffect(() => {
    console.error('Chat error:', error);
  }, [error]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
      <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="size-8 text-destructive" />
      </div>
      <div className="text-center">
        <h2 className="text-lg font-semibold">Failed to load chat</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md">
          {error.message || 'Unable to load this conversation. It may have been deleted or you may not have access.'}
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" onClick={() => router.push('/')}>
          New chat
        </Button>
        <Button onClick={reset}>Try again</Button>
      </div>
    </div>
  );
}
