'use client';

import { cn } from '@/lib/utils';
import type { Integration } from '@/types';

interface MentionChipProps {
  slug: string;
  integration: Integration | null;
}

const CHIP_BASE =
  'inline rounded-sm align-baseline text-[0.95em] font-semibold leading-[inherit] cursor-default';
const CHIP_LIVE = 'bg-muted text-foreground';
const CHIP_DELETED = 'bg-muted/60 text-muted-foreground';

export function MentionChip({ slug, integration }: MentionChipProps) {
  const isDeleted = integration === null;

  return (
    <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
      @{slug}
    </span>
  );
}
