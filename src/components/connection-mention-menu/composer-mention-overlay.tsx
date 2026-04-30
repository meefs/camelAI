'use client';

import type { PointerEvent, ReactNode, RefObject } from 'react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { CATEGORY_TAB_LABELS } from '@/components/connection-picker/use-connection-filter';
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import { parseMentions } from '@/lib/connection-mentions';
import type { Integration } from '@/types';

interface ComposerMentionOverlayProps {
  value: string;
  slugMap: Map<string, Integration>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}

const COMPOSER_CHIP_CLASS =
  'pointer-events-auto select-none rounded-sm bg-muted text-foreground ' +
  'shadow-[0_0_0_2px_var(--muted)]';

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
      {!integration.has_credentials && (
        <div className="flex items-center gap-1.5 text-xs">
          <span className="inline-block size-1.5 rounded-full bg-amber-500" />
          <span className="text-muted-foreground">No credentials configured</span>
        </div>
      )}
      <div className="text-xs text-muted-foreground">
        Updated {formatRelative(integration.updated_at)}
      </div>
    </div>
  );
}

function ComposerChip({
  slug,
  integration,
  textareaRef,
  startIndex,
  endIndex,
}: {
  slug: string;
  integration: Integration;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  startIndex: number;
  endIndex: number;
}) {
  const handlePointerDown = (event: PointerEvent<HTMLSpanElement>) => {
    event.preventDefault();
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.focus();
    textarea.setSelectionRange(startIndex, endIndex);
  };

  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>
        <span
          className={COMPOSER_CHIP_CLASS}
          onPointerDown={handlePointerDown}
        >
          @{slug}
        </span>
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
  textareaRef: RefObject<HTMLTextAreaElement | null>,
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
        textareaRef={textareaRef}
        startIndex={match.index}
        endIndex={match.index + match.length}
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
  textareaRef,
}: ComposerMentionOverlayProps) {
  return <>{renderComposerTokens(value, slugMap, textareaRef)}</>;
}
