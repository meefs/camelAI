'use client';

import type { ReactElement } from 'react';
import { FolderGit2 } from 'lucide-react';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { CATEGORY_TAB_LABELS } from '@/components/connection-picker/use-connection-filter';
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import type { AtMentionConnection, AtMentionEntity } from '@/types';

export function formatRelative(timestamp: number): string {
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

function ConnectionHoverPreview({ target }: { target: AtMentionConnection }) {
  const integration = target;
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

function ProjectHoverPreview({ target }: { target: AtMentionEntity & { kind: 'project' } }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{target.name}</span>
      </div>
      <div className="text-xs text-muted-foreground">Project</div>
      {target.description.trim() ? (
        <div className="line-clamp-2 text-xs text-muted-foreground">
          {target.description}
        </div>
      ) : null}
      {typeof target.updated_at === 'number' ? (
        <div className="text-xs text-muted-foreground">
          Updated {formatRelative(target.updated_at)}
        </div>
      ) : null}
    </div>
  );
}

export function MentionTargetHoverPreview({ target }: { target: AtMentionEntity }) {
  return target.kind === 'connection'
    ? <ConnectionHoverPreview target={target} />
    : <ProjectHoverPreview target={target} />;
}

export function MentionTargetHoverCard({
  target,
  children,
  side = 'bottom',
}: {
  target: AtMentionEntity;
  children: ReactElement;
  side?: 'top' | 'right' | 'bottom' | 'left';
}) {
  return (
    <HoverCard openDelay={200} closeDelay={100}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent
        side={side}
        align="start"
        collisionPadding={12}
        className="w-auto min-w-[200px] max-w-[280px] rounded-md border border-border p-2 shadow-md ring-0"
      >
        <MentionTargetHoverPreview target={target} />
      </HoverCardContent>
    </HoverCard>
  );
}
