import type { ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface OnboardingOptionProps {
  selected?: boolean;
  onClick: () => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  disabled?: boolean;
}

export function OnboardingOption({
  selected = false,
  onClick,
  title,
  description,
  icon,
  disabled = false,
}: OnboardingOptionProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full rounded-xl border p-4 text-left transition-colors',
        'hover:border-foreground/30 hover:bg-muted/40',
        selected && 'border-foreground bg-muted',
        disabled && 'pointer-events-none'
      )}
    >
      <div className="flex items-start gap-3">
        {icon ? <div className="mt-0.5 text-muted-foreground">{icon}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="font-medium">{title}</div>
          {description ? (
            <div className="mt-1 text-sm text-muted-foreground">{description}</div>
          ) : null}
        </div>
        <div
          className={cn(
            'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
            selected ? 'border-foreground bg-foreground text-background' : 'border-muted-foreground/40'
          )}
        >
          {selected ? <Check className="h-3 w-3" /> : null}
        </div>
      </div>
    </button>
  );
}
