'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ConnectionChip } from './connection-chip';
import {
  useConnectionFilter,
  CATEGORY_TAB_LABELS,
  type FilterableIntegration,
} from './use-connection-filter';

interface ConnectionPickerProps {
  integrations: FilterableIntegration[];
  mode: 'single-action' | 'multi-select';
  variant: 'large' | 'compact';
  showSearch?: boolean;
  showCategoryTabs?: boolean;
  maxHeight?: string;
  selectedIds?: string[];
  onToggle?: (id: string) => void;
  onSelect?: (integration: { type: string; displayName: string }) => void;
  excludeTypes?: string[];
  searchPlaceholder?: string;
}

export function ConnectionPicker({
  integrations,
  mode,
  variant,
  showSearch = true,
  showCategoryTabs = true,
  maxHeight,
  selectedIds,
  onToggle,
  onSelect,
  excludeTypes,
  searchPlaceholder = 'Search integrations...',
}: ConnectionPickerProps) {
  const {
    searchQuery,
    setSearchQuery,
    activeCategory,
    setActiveCategory,
    filteredIntegrations,
    categories,
  } = useConnectionFilter(integrations, excludeTypes);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showFade, setShowFade] = useState(false);

  const checkFade = useCallback(() => {
    const el = scrollRef.current;
    if (!el) {
      setShowFade(false);
      return;
    }
    const hasOverflow = el.scrollHeight > el.clientHeight;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 2;
    setShowFade(hasOverflow && !isAtBottom);
  }, []);

  useEffect(() => {
    checkFade();
  }, [filteredIntegrations, checkFade]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Check after initial render / layout
    const raf = requestAnimationFrame(checkFade);
    return () => cancelAnimationFrame(raf);
  }, [checkFade]);

  const handleChipClick = (integration: FilterableIntegration) => {
    if (mode === 'multi-select' && onToggle) {
      onToggle(integration.type);
    } else if (mode === 'single-action' && onSelect) {
      onSelect({ type: integration.type, displayName: integration.displayName });
    }
  };

  return (
    <div className="space-y-3">
      {showSearch && (
        <div className="relative">
          <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="pl-9 pr-8"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute inset-y-0 right-0 inline-flex items-center px-3 text-muted-foreground hover:text-foreground"
              aria-label="Clear search"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      )}

      {showCategoryTabs && categories.length > 2 && (
        <div className="flex flex-wrap gap-1.5">
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              onClick={() => setActiveCategory(cat)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                activeCategory === cat
                  ? 'bg-foreground text-background'
                  : 'bg-muted text-muted-foreground hover:text-foreground'
              )}
            >
              {CATEGORY_TAB_LABELS[cat] ?? cat}
            </button>
          ))}
        </div>
      )}

      <div className="relative">
        <div
          ref={scrollRef}
          onScroll={checkFade}
          className={cn(
            variant === 'large'
              ? 'grid gap-2 sm:grid-cols-2 lg:grid-cols-3'
              : 'flex flex-wrap gap-2',
            maxHeight && 'overflow-y-auto'
          )}
          style={maxHeight ? { maxHeight } : undefined}
        >
          {filteredIntegrations.length === 0 ? (
            <div className="col-span-full py-6 text-center text-sm text-muted-foreground">
              No integrations found
            </div>
          ) : (
            filteredIntegrations.map((integration) => (
              <ConnectionChip
                key={integration.type}
                type={integration.type}
                displayName={integration.displayName}
                variant={variant}
                isSelected={
                  mode === 'multi-select'
                    ? selectedIds?.includes(integration.type)
                    : undefined
                }
                showAuthType={
                  variant === 'large'
                    ? ('authMethod' in integration
                        ? (integration as FilterableIntegration & { authMethod?: string }).authMethod === 'oauth2'
                          ? 'OAuth'
                          : 'API Key'
                        : undefined)
                    : undefined
                }
                onClick={() => handleChipClick(integration)}
              />
            ))
          )}
        </div>
        {showFade && maxHeight && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-background to-transparent" />
        )}
      </div>
    </div>
  );
}
