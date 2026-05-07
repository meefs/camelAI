'use client';

import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Link } from 'react-router';
import { ModelLogo } from '@/components/model-logo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import { MODEL_CATALOG, type ModelCatalogEntry } from '@/lib/model-catalog';
import {
  setRecentModel,
  type RecentModelScope,
} from '@/lib/recent-model';
import { cn } from '@/lib/utils';
import type { LlmModel } from '@/types';

interface ModelPickerProps {
  value: LlmModel;
  onValueChange: (model: LlmModel) => void;
  options: ReadonlyArray<ModelCatalogEntry>;
  isOrgAdmin: boolean;
  recentModelScope?: RecentModelScope | null;
  disabled?: boolean;
  manageModelsHref?: string;
}

function MetadataRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function ModelMetadataCard({ entry }: { entry: ModelCatalogEntry }) {
  return (
    <HoverCardContent side="right" align="start" sideOffset={8} className="w-48">
      <div className="space-y-2">
        <div className="font-medium">{entry.label}</div>
        <div className="h-px bg-border/60" />
        <div className="space-y-1.5">
          <MetadataRow label="cost" value={entry.cost} />
          <MetadataRow label="intelligence" value={entry.intelligence} />
          <MetadataRow label="speed" value={entry.speed} />
        </div>
      </div>
    </HoverCardContent>
  );
}

export function ModelPicker({
  value,
  onValueChange,
  options,
  isOrgAdmin,
  recentModelScope,
  disabled = false,
  manageModelsHref = '/settings/organization/models',
}: ModelPickerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openModelId, setOpenModelId] = useState<LlmModel | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedEntry =
    options.find((option) => option.id === value) ?? MODEL_CATALOG[value];

  function clearPendingOpen() {
    if (openTimerRef.current === null) return;
    clearTimeout(openTimerRef.current);
    openTimerRef.current = null;
  }

  function closeAllMetadata() {
    clearPendingOpen();
    setOpenModelId(null);
  }

  function closeMetadata(model: LlmModel) {
    clearPendingOpen();
    setOpenModelId((current) => (current === model ? null : current));
  }

  function queueMetadataOpen(model: LlmModel) {
    clearPendingOpen();
    openTimerRef.current = setTimeout(() => {
      setOpenModelId(model);
      openTimerRef.current = null;
    }, 150);
  }

  useEffect(
    () => () => {
      if (openTimerRef.current === null) return;
      clearTimeout(openTimerRef.current);
    },
    [],
  );

  function handleSelect(model: LlmModel) {
    closeAllMetadata();
    onValueChange(model);
    if (recentModelScope) {
      setRecentModel(recentModelScope, model);
    }
  }

  return (
    <DropdownMenu
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (!open) {
          closeAllMetadata();
        }
      }}
    >
      <DropdownMenuTrigger asChild disabled={disabled}>
        <button
          type="button"
          aria-label="Thread model"
          disabled={disabled}
          className={cn(
            'h-auto gap-1 rounded-none border-0 !bg-transparent px-0 py-0 text-xs font-medium text-muted-foreground shadow-none hover:!bg-transparent hover:text-foreground focus-visible:border-0 focus-visible:text-foreground focus-visible:ring-0 focus-visible:underline focus-visible:underline-offset-4',
            disabled && 'pointer-events-none opacity-50',
          )}
        >
          {selectedEntry.label}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        {options.map((entry) => {
          const isSelected = entry.id === value;
          return (
            <HoverCard
              key={entry.id}
              open={openModelId === entry.id}
              openDelay={0}
              closeDelay={0}
            >
              <HoverCardTrigger asChild>
                <DropdownMenuItem
                  onSelect={() => handleSelect(entry.id)}
                  onPointerEnter={() => queueMetadataOpen(entry.id)}
                  onPointerLeave={() => closeMetadata(entry.id)}
                  onFocus={(event) => {
                    if (event.currentTarget.matches(':hover')) return;
                    clearPendingOpen();
                    setOpenModelId(entry.id);
                  }}
                  onBlur={() => closeMetadata(entry.id)}
                  className={cn(
                    'gap-2 pr-2',
                    isSelected && 'bg-accent text-accent-foreground',
                  )}
                >
                  <ModelLogo model={entry.id} size={16} className="size-4" />
                  <span className="min-w-0 flex-1 truncate">
                    {entry.label}
                  </span>
                  {isSelected && <Check className="ml-auto size-3.5" />}
                </DropdownMenuItem>
              </HoverCardTrigger>
              {openModelId === entry.id && <ModelMetadataCard entry={entry} />}
            </HoverCard>
          );
        })}
        {isOrgAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild className="text-xs text-muted-foreground">
              <Link to={manageModelsHref}>Manage models</Link>
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
