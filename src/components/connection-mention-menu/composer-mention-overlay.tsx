'use client';

import type { ReactNode } from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { CATEGORY_TAB_LABELS } from '@/components/connection-picker/use-connection-filter';
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import { parseMentions } from '@/lib/connection-mentions';
import { cn } from '@/lib/utils';
import type { Integration } from '@/types';

interface ComposerMentionOverlayProps {
  value: string;
  slugMap: Map<string, Integration>;
}

const COMPOSER_CHIP_CLASS =
  'pointer-events-auto rounded-md bg-muted px-1 py-0 -mx-0.5 ' +
  'font-semibold text-foreground';

function formatRelative(timestamp: number): string {
  const diff = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;

  const months = Math.floor(days / 30);
  if (months < 12) {
    return `${months} month${months === 1 ? '' : 's'} ago`;
  }

  const years = Math.floor(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

function ChipHoverPreview({ integration }: { integration: Integration }) {
  const def = getIntegrationDefinition(integration.integration_type);
  const category = def?.category ?? integration.category;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <IntegrationIcon
          type={integration.integration_type}
          size={16}
          className="size-4 shrink-0"
        />
        <span className="text-sm font-medium">{integration.name}</span>
      </div>
      <div className="text-xs text-muted-foreground">
        {def?.displayName ?? integration.integration_type}
        {category ? ` · ${CATEGORY_TAB_LABELS[category] ?? category}` : ''}
      </div>
      <div className="flex items-center gap-1.5 text-xs">
        <span
          className={cn(
            'inline-block size-1.5 rounded-full',
            integration.has_credentials ? 'bg-emerald-500' : 'bg-amber-500',
          )}
        />
        <span className="text-muted-foreground">
          {integration.has_credentials ? 'Ready' : 'Credentials missing'}
        </span>
        <span className="ml-auto text-muted-foreground">
          Updated {formatRelative(integration.updated_at)}
        </span>
      </div>
    </div>
  );
}

function ComposerChip({
  slug,
  integration,
}: {
  slug: string;
  integration: Integration;
}) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span className={COMPOSER_CHIP_CLASS}>@{slug}</span>
      </HoverCardTrigger>
      <HoverCardContent
        side="top"
        align="start"
        className="w-auto min-w-[200px] max-w-[280px] rounded-md border border-border p-2 shadow-md ring-0"
      >
        <ChipHoverPreview integration={integration} />
      </HoverCardContent>
    </HoverCard>
  );
}

function renderComposerTokens(
  value: string,
  slugMap: Map<string, Integration>,
): ReactNode[] {
  if (!value) return [];

  const matches = parseMentions(value, slugMap);
  const output: ReactNode[] = [];
  let cursor = 0;

  for (const match of matches) {
    if (match.integration === null) {
      continue;
    }

    if (match.index > cursor) {
      output.push(value.slice(cursor, match.index));
    }
    output.push(
      <ComposerChip
        key={`${match.index}-${match.slug}`}
        slug={match.slug}
        integration={match.integration as Integration}
      />,
    );
    cursor = match.index + match.length;
  }

  if (cursor < value.length) {
    output.push(value.slice(cursor));
  }

  return output;
}

export function ComposerMentionOverlay({
  value,
  slugMap,
}: ComposerMentionOverlayProps) {
  return <>{renderComposerTokens(value, slugMap)}</>;
}
