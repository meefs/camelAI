'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { Plus } from 'lucide-react';
import {
  Command,
  CommandGroup,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
} from '@/components/ui/popover';
import { IntegrationIcon } from '@/lib/integration-icons';
import { getIntegrationDefinition } from '@/lib/integration-registry';
import {
  filterMentionableConnections,
  rankMentionableConnections,
} from '@/lib/connection-mentions';
import type { Integration } from '@/types';

export interface ConnectionMentionMenuProps {
  open: boolean;
  query: string;
  connections: Integration[];
  anchorRef: RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  /** Currently highlighted connection id (controlled). */
  activeId: string | null;
  onActiveIdChange: (id: string | null) => void;
  onSelect: (connection: Integration) => void;
  onClose: () => void;
  onAddNewClick: () => void;
}

const ADD_CONNECTION_VALUE = '__add_connection__';

export function ConnectionMentionMenu({
  open,
  query,
  connections,
  anchorRef,
  side = 'top',
  activeId,
  onActiveIdChange,
  onSelect,
  onClose,
  onAddNewClick,
}: ConnectionMentionMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [anchorWidth, setAnchorWidth] = useState<number | null>(null);
  const mentionableConnections = useMemo(
    () => filterMentionableConnections(connections),
    [connections],
  );
  const filtered = useMemo(
    () => rankMentionableConnections(mentionableConnections, query),
    [mentionableConnections, query],
  );

  const showAddRow = mentionableConnections.length === 0;

  // Keep activeId in sync with the visible list — pick the first match when
  // the current selection drops out, or when the list opens.
  useEffect(() => {
    if (!open) return;
    if (showAddRow) {
      if (activeId !== ADD_CONNECTION_VALUE) {
        onActiveIdChange(ADD_CONNECTION_VALUE);
      }
      return;
    }
    if (filtered.length === 0) return;
    const stillVisible = activeId && filtered.some((c) => c.id === activeId);
    if (!stillVisible) {
      onActiveIdChange(filtered[0]!.id);
    }
  }, [open, filtered, activeId, onActiveIdChange, showAddRow]);

  useLayoutEffect(() => {
    if (!open) return;
    const el = anchorRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const update = () => setAnchorWidth(el.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open || !activeId) return;
    const list = listRef.current;
    if (!list) return;

    const activeEl = Array.from(
      list.querySelectorAll<HTMLElement>('[data-value]'),
    ).find((element) => element.getAttribute('data-value') === activeId);

    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [open, activeId]);

  if (!open) return null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <PopoverAnchor virtualRef={anchorRef as RefObject<HTMLElement>} />
      <PopoverContent
        side={side}
        align="start"
        sideOffset={4}
        avoidCollisions={false}
        collisionPadding={8}
        onOpenAutoFocus={(e) => e.preventDefault()}
        onCloseAutoFocus={(e) => e.preventDefault()}
        onPointerDownOutside={(e) => {
          // Let clicks on the textarea / its toolbar pass through; closing on
          // outside-click is handled separately so we don't fight Radix's own
          // outside detection on the textarea itself.
          const target = e.target as Node | null;
          if (target && anchorRef.current?.contains(target)) {
            e.preventDefault();
          }
        }}
        style={anchorWidth ? { width: `${anchorWidth}px` } : undefined}
        className="min-w-[240px] p-0 overflow-hidden rounded-md ring-1 ring-foreground/10 bg-popover text-popover-foreground shadow-md"
      >
        <Command
          shouldFilter={false}
          value={activeId ?? undefined}
          onValueChange={(v) => onActiveIdChange(v)}
          className="bg-transparent p-0 rounded-none"
        >
          <CommandList ref={listRef} className="max-h-[200px] py-1">
            <CommandGroup className="p-0">
              {showAddRow ? (
                <CommandItem
                  value={ADD_CONNECTION_VALUE}
                  onSelect={() => {
                    onAddNewClick();
                    onClose();
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
                >
                  <Plus className="size-4 shrink-0" />
                  <span className="font-medium">Add a connection</span>
                </CommandItem>
              ) : (
                filtered.map((c) => {
                  const def = getIntegrationDefinition(c.integration_type);
                  return (
                    <CommandItem
                      key={c.id}
                      value={c.id}
                      onSelect={() => onSelect(c)}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
                    >
                      <IntegrationIcon
                        type={c.integration_type}
                        size={16}
                        className="size-4 shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{c.name}</span>
                      <span className="shrink-0 pl-3 text-xs text-muted-foreground">
                        {def?.displayName ?? c.integration_type}
                      </span>
                    </CommandItem>
                  );
                })
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
