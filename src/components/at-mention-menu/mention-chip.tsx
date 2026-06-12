'use client';

import { cn } from '@/lib/utils';
import type { AtMentionEntity } from '@/types';

interface MentionChipProps {
  slug: string;
  target: AtMentionEntity | null;
}

const CHIP_BASE =
  'inline rounded-md px-1.5 py-0.5 -my-0.5 align-baseline font-normal leading-[inherit] cursor-default';
const CHIP_LIVE = 'bg-muted text-foreground';
const CHIP_DELETED = 'bg-muted/60 text-muted-foreground';

export function MentionChip({ slug, target }: MentionChipProps) {
  const isDeleted = target === null;

  return (
    <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
      @{slug}
    </span>
  );
}
