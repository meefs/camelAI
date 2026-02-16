import { memo } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { PreviewTab } from '@/types';
import { getTabIcon, getTabLabel } from './preview-utils';

interface PreviewTabRowProps {
  tabs: PreviewTab[];
  activeTabId: string;
  onTabSelect: (tabId: string) => void;
  onTabClose: (tabId: string) => void;
}

function PreviewTabRowComponent({
  tabs,
  activeTabId,
  onTabSelect,
  onTabClose,
}: PreviewTabRowProps) {
  if (tabs.length === 0) return null;

  if (tabs.length === 1) {
    const tab = tabs[0];
    const label = getTabLabel(tab.target);
    const Icon = getTabIcon(tab.target);
    return (
      <div className="flex items-center justify-between border-b border-border px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs text-foreground">{label}</span>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => onTabClose(tab.id)}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Close preview tab"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    );
  }

  return (
    <div
      className="flex items-stretch overflow-x-auto border-b border-border bg-muted/20"
      style={{ scrollbarWidth: 'none' }}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTabId;
        const label = getTabLabel(tab.target);
        const Icon = getTabIcon(tab.target);

        return (
          <div
            key={tab.id}
            className={cn(
              'group/tab flex shrink-0 items-center border-b-2 px-2 py-1.5 transition-colors',
              isActive
                ? 'border-foreground bg-background text-foreground'
                : 'border-transparent bg-muted/30 text-muted-foreground hover:bg-muted/50 hover:text-foreground'
            )}
            role="tab"
            aria-selected={isActive}
            tabIndex={0}
            onClick={() => onTabSelect(tab.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                onTabSelect(tab.id);
              }
            }}
          >
            <div className="flex min-w-0 items-center gap-1.5 py-0.5">
              <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <span className="max-w-[140px] truncate font-mono text-xs">{label}</span>
            </div>
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onTabClose(tab.id);
              }}
              className={cn(
                'ml-1 flex h-4 w-4 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-foreground/10 hover:text-foreground',
                isActive ? 'opacity-100' : 'opacity-0 group-hover/tab:opacity-100'
              )}
              aria-label={`Close ${label}`}
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        );
      })}
    </div>
  );
}

export const PreviewTabRow = memo(PreviewTabRowComponent);
