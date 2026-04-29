'use client';

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import type { Integration, IntegrationCategory } from '@/types';
import { CATEGORY_TAB_LABELS } from '@/components/connection-picker/use-connection-filter';
import { cn } from '@/lib/utils';

interface MentionChipProps {
  slug: string;
  integration: Integration | null;
}

const CHIP_BASE =
  'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 -my-0.5 align-baseline text-[0.95em] font-medium leading-none cursor-default';
const CHIP_LIVE =
  'border-border text-foreground transition-colors hover:bg-muted/50';
const CHIP_DELETED =
  'border-dashed border-border text-muted-foreground';

function categoryLabel(category: IntegrationCategory | undefined): string {
  if (!category) return '';
  return CATEGORY_TAB_LABELS[category] ?? category;
}

export function MentionChip({ slug, integration }: MentionChipProps) {
  const isDeleted = integration === null;
  const def = integration
    ? getIntegrationDefinition(integration.integration_type)
    : null;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
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
      </TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-[260px] px-3 py-2">
        {isDeleted ? (
          <div className="text-xs text-muted-foreground">
            Connection no longer available
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <IntegrationIcon
                type={integration!.integration_type}
                size={14}
                className="size-3.5 shrink-0"
              />
              <span className="text-sm font-medium">{integration!.name}</span>
            </div>
            <div className="mt-0.5 text-xs text-muted-foreground">
              {def?.displayName ?? integration!.integration_type}
              {def ? ` · ${categoryLabel(def.category)}` : ''}
            </div>
          </>
        )}
      </TooltipContent>
    </Tooltip>
  );
}
