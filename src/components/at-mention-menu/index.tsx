'use client';

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type RefObject,
} from 'react';
import { FolderGit2, Plus } from 'lucide-react';
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
  filterMentionables,
  rankMentionables,
} from '@/lib/mentions';
import type { AtMentionEntity } from '@/types';

export interface AtMentionMenuProps {
  open: boolean;
  query: string;
  items: AtMentionEntity[];
  anchorRef: RefObject<HTMLElement | null>;
  side?: 'top' | 'bottom';
  /** Currently highlighted composite item value (controlled). */
  activeValue: string | null;
  onActiveValueChange: (value: string | null) => void;
  onSelect: (item: AtMentionEntity) => void;
  onClose: () => void;
  onAddNewClick: () => void;
}

const ADD_CONNECTION_VALUE = '__add_connection__';

function keepComposerFocused(event: MouseEvent<HTMLDivElement>) {
  // The textarea owns menu visibility, so preserve its focus until cmdk's
  // click handler can select the row.
  event.preventDefault();
}

export function mentionItemValue(item: Pick<AtMentionEntity, 'kind' | 'id'>): string {
  return `${item.kind}:${item.id}`;
}

export function AtMentionMenu({
  open,
  query,
  items,
  anchorRef,
  side = 'top',
  activeValue,
  onActiveValueChange,
  onSelect,
  onClose,
  onAddNewClick,
}: AtMentionMenuProps) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const [anchorWidth, setAnchorWidth] = useState<number | null>(null);
  const mentionableItems = useMemo(
    () => filterMentionables(items),
    [items],
  );
  const filtered = useMemo(
    () => rankMentionables(mentionableItems, query),
    [mentionableItems, query],
  );

  const showAddRow = mentionableItems.length === 0;

  // Keep activeValue in sync with the visible list — pick the first match when
  // the current selection drops out, or when the list opens.
  useEffect(() => {
    if (!open) return;
    if (showAddRow) {
      if (activeValue !== ADD_CONNECTION_VALUE) {
        onActiveValueChange(ADD_CONNECTION_VALUE);
      }
      return;
    }
    if (filtered.length === 0) return;
    const stillVisible = activeValue &&
      filtered.some((item) => mentionItemValue(item) === activeValue);
    if (!stillVisible) {
      onActiveValueChange(mentionItemValue(filtered[0]!));
    }
  }, [open, filtered, activeValue, onActiveValueChange, showAddRow]);

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
    if (!open || !activeValue) return;
    const list = listRef.current;
    if (!list) return;

    const activeEl = Array.from(
      list.querySelectorAll<HTMLElement>('[data-value]'),
    ).find((element) => element.getAttribute('data-value') === activeValue);

    activeEl?.scrollIntoView({ block: 'nearest' });
  }, [open, activeValue]);

  if (!open) return null;

  const renderItem = (item: AtMentionEntity) => {
    const itemValue = mentionItemValue(item);
    const def = item.kind === 'connection'
      ? getIntegrationDefinition(item.integration_type)
      : null;
    return (
      <CommandItem
        key={itemValue}
        value={itemValue}
        onMouseDown={keepComposerFocused}
        onSelect={() => onSelect(item)}
        className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
      >
        {item.kind === 'connection' ? (
          <IntegrationIcon
            type={item.integration_type}
            size={16}
            className="size-4 shrink-0"
          />
        ) : (
          <FolderGit2 className="size-4 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate font-medium">{item.name}</span>
        <span className="shrink-0 pl-3 text-xs text-muted-foreground">
          {item.kind === 'connection'
            ? def?.displayName ?? item.integration_type
            : 'Project'}
        </span>
      </CommandItem>
    );
  };

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
          value={activeValue ?? undefined}
          onValueChange={(v) => onActiveValueChange(v)}
          className="bg-transparent p-0 rounded-none"
        >
          <CommandList
            ref={listRef}
            className="py-1"
            style={{
              maxHeight:
                'min(200px, var(--radix-popover-content-available-height, 200px))',
            }}
          >
            <CommandGroup className="p-0">
              {showAddRow ? (
                <CommandItem
                  value={ADD_CONNECTION_VALUE}
                  onMouseDown={keepComposerFocused}
                  onSelect={() => {
                    onAddNewClick();
                    onClose();
                  }}
                  className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer"
                >
                  <Plus className="size-4 shrink-0" />
                  <span className="font-medium">Add a connection</span>
                </CommandItem>
              ) : filtered.map(renderItem)}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
