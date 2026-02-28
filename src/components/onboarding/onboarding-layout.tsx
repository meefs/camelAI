import { useEffect, useState, type ReactNode } from 'react';
import { FullLogo } from '@/components/ui/logo';
import { cn } from '@/lib/utils';

interface OnboardingLayoutProps {
  children: ReactNode;
  contentClassName?: string;
}

export function OnboardingLayout({
  children,
  contentClassName,
}: OnboardingLayoutProps) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-4xl flex-col px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center">
        <FullLogo className="h-7" />
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div
          className={cn(
            'w-full max-w-2xl transform-gpu transition-all duration-300 ease-out',
            entered ? 'translate-x-0 opacity-100' : 'opacity-0',
            contentClassName
          )}
        >
          {children}
        </div>
      </div>
    </div>
  );
}
