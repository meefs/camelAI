import { useEffect, useState, type ReactNode } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { LogoIcon } from '@/components/ui/logo';
import { cn } from '@/lib/utils';
import { OnboardingProgress } from './onboarding-progress';
import type { OnboardingTransitionDirection } from '@/lib/onboarding';

interface OnboardingLayoutProps {
  children: ReactNode;
  currentStep: number;
  totalSteps: number;
  onBack?: () => void;
  onSkip?: () => void;
  showBack?: boolean;
  showSkip?: boolean;
  contentClassName?: string;
  transitionDirection?: OnboardingTransitionDirection;
}

export function OnboardingLayout({
  children,
  currentStep,
  totalSteps,
  onBack,
  onSkip,
  showBack = true,
  showSkip = true,
  contentClassName,
  transitionDirection = 'none',
}: OnboardingLayoutProps) {
  const [entered, setEntered] = useState(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const enteringStateClass =
    transitionDirection === 'backward'
      ? '-translate-x-8 opacity-0'
      : transitionDirection === 'forward'
        ? 'translate-x-8 opacity-0'
        : 'opacity-0';

  return (
    <div className="mx-auto flex min-h-svh w-full max-w-4xl flex-col px-4 py-8 sm:px-6">
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-medium">
          <LogoIcon />
          <span>camelAI</span>
        </div>
        <div className="flex items-center gap-2">
          {showBack && onBack ? (
            <Button type="button" variant="ghost" size="sm" onClick={onBack}>
              <ArrowLeft className="h-4 w-4" />
              Back
            </Button>
          ) : (
            <div />
          )}
          {showSkip && onSkip ? (
            <Button type="button" variant="ghost" size="sm" onClick={onSkip}>
              Skip
              <ArrowRight className="h-4 w-4" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center">
        <div
          className={cn(
            'w-full max-w-2xl transform-gpu transition-all duration-300 ease-out',
            entered ? 'translate-x-0 opacity-100' : enteringStateClass,
            contentClassName
          )}
        >
          {children}
        </div>
      </div>

      <div className="mt-8">
        <OnboardingProgress current={currentStep} total={totalSteps} />
      </div>
    </div>
  );
}
