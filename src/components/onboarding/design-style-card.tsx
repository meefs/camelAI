import type { ComponentType } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';

interface DesignStyleCardProps {
  label: string;
  preview: ComponentType;
  selected: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export function DesignStyleCard({
  label,
  preview: Preview,
  selected,
  onClick,
  disabled = false,
}: DesignStyleCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'group block w-full self-start text-left',
        disabled && 'pointer-events-none'
      )}
    >
      <div
        className={cn(
          'pointer-events-none select-none transition-opacity duration-200',
          !selected && 'group-hover:opacity-80'
        )}
      >
        <Preview />
      </div>

      <div className="mt-2 flex items-center gap-1.5">
        <div
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-full border transition-colors',
            selected
              ? 'border-foreground bg-foreground text-background'
              : 'border-muted-foreground/40 group-hover:border-muted-foreground'
          )}
        >
          {selected ? <Check className="size-2.5" strokeWidth={3} /> : null}
        </div>
        <span
          className={cn(
            'text-sm transition-colors',
            selected
              ? 'font-medium text-foreground'
              : 'text-muted-foreground group-hover:text-foreground'
          )}
        >
          {label}
        </span>
      </div>
    </button>
  );
}
