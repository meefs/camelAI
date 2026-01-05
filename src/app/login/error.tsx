'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { AlertCircle } from 'lucide-react';
import { LogoIcon } from '@/components/ui/logo';

export default function LoginError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Login error:', error);
  }, [error]);

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 p-8">
      <Link href="/" className="flex items-center gap-2">
        <LogoIcon />
        <span className="text-lg font-semibold tracking-tight">Chiridion</span>
      </Link>

      <div className="flex size-16 items-center justify-center rounded-full bg-destructive/10">
        <AlertCircle className="size-8 text-destructive" />
      </div>

      <div className="text-center">
        <h2 className="text-lg font-semibold">Login error</h2>
        <p className="mt-1 text-sm text-muted-foreground max-w-md">
          {error.message || 'An error occurred during login. Please try again.'}
        </p>
      </div>

      <Button onClick={reset}>Try again</Button>
    </div>
  );
}
