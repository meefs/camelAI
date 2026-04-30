'use client';

import { IntegrationIcon } from '@/lib/integration-icons';
import { cn } from '@/lib/utils';
import type { Integration } from '@/types';

interface MentionChipProps {
  slug: string;
  integration: Integration | null;
}

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md px-1 py-0 -mx-0.5 ' +
  'align-baseline text-[0.95em] font-semibold leading-[inherit] cursor-default';
const CHIP_LIVE = 'bg-muted text-foreground';
const CHIP_DELETED = 'bg-muted/60 text-muted-foreground';

export function MentionChip({ slug, integration }: MentionChipProps) {
  const isDeleted = integration === null;

  return (
    <span className={cn(CHIP_BASE, isDeleted ? CHIP_DELETED : CHIP_LIVE)}>
      {integration && (
        <IntegrationIcon
          type={integration.integration_type}
          size={12}
          className="size-3 shrink-0 opacity-70"
        />
      )}
      <span>@{slug}</span>
    </span>
  );
}
