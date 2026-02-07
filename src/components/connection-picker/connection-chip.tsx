'use client';

import { Plus } from 'lucide-react';
import { IntegrationIcon } from '@/lib/integration-icons';
import { cn } from '@/lib/utils';

interface ConnectionChipProps {
  type: string;
  displayName: string;
  variant: 'large' | 'compact';
  isSelected?: boolean;
  showAuthType?: string;
  onClick: () => void;
}

export function ConnectionChip({
  type,
  displayName,
  variant,
  isSelected,
  showAuthType,
  onClick,
}: ConnectionChipProps) {
  if (variant === 'large') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-3 rounded-lg border bg-card p-3 text-left transition-colors hover:bg-accent"
      >
        <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted">
          <IntegrationIcon type={type} className="size-5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{displayName}</div>
          {showAuthType && (
            <div className="text-xs text-muted-foreground">{showAuthType}</div>
          )}
        </div>
        <Plus className="size-4 shrink-0 text-muted-foreground" />
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors',
        isSelected
          ? 'border-foreground bg-muted font-medium'
          : 'hover:border-foreground/30'
      )}
    >
      <IntegrationIcon type={type} size={16} className="size-4 shrink-0" />
      <span>{displayName}</span>
    </button>
  );
}
