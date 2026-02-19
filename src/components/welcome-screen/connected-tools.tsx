'use client';

import { IntegrationIcon, resolveLogoType } from '@/lib/integration-icons';
import { cn } from '@/lib/utils';
import type { Integration } from '@/types';

interface ConnectedToolsProps {
  connections: Integration[];
  onSelect: (connection: Integration) => void;
}

export function ConnectedTools({ connections, onSelect }: ConnectedToolsProps) {
  return (
    <div className="flex flex-wrap gap-3">
      {connections.map((connection) => {
        const label = connection.name || connection.integration_type;
        return (
          <button
            key={connection.id}
            type="button"
            onClick={() => onSelect(connection)}
            className={cn(
              'inline-flex items-center gap-2 px-4 py-2.5 rounded-lg cursor-pointer',
              'border border-border bg-card hover:bg-accent/50',
              'transition-all duration-200 ease-out text-sm',
              'hover:border-ring hover:shadow-md'
            )}
          >
            <IntegrationIcon
              type={resolveLogoType(connection.integration_type, [
                (connection.config as Record<string, unknown>)?.display_name as string,
                connection.name,
              ])}
              size={16}
            />
            <span className="text-foreground">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
