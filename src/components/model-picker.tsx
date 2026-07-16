'use client';

import { Fragment, useEffect, useRef, useState } from 'react';
import { Check, Lock, LockOpen } from 'lucide-react';
import { Link } from 'react-router';
import { ModelLogo } from '@/components/model-logo';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/components/ui/hover-card';
import {
  COST_BUCKET_MAX,
  MODEL_CATALOG,
  type CostBucket,
} from '@/lib/model-catalog';
import { CAMEL_FREE_LLM_MODEL } from '@/lib/llm-provider-config';
import {
  setRecentModel,
  type RecentModelScope,
} from '@/lib/recent-model';
import { cn } from '@/lib/utils';
import type { LlmModel } from '@/types';
import type { ModelPickerOption } from '@/lib/chat-do.server';

interface ModelPickerProps {
  value: LlmModel;
  onValueChange: (model: LlmModel) => void;
  options: ReadonlyArray<ModelPickerOption>;
  isOrgAdmin: boolean;
  onLockedModelSelect?: (model: LlmModel) => void;
  onUnlockRequest?: () => void;
  recentModelScope?: RecentModelScope | null;
  disabled?: boolean;
  manageModelsHref?: string;
}

const RATING_MAX = 5;

function RatingDot({ fill }: { fill: 'full' | 'half' | 'empty' }) {
  return (
    <svg viewBox="0 0 10 10" aria-hidden="true" className="size-1.5 shrink-0">
      <circle
        cx="5"
        cy="5"
        r="5"
        fill="currentColor"
        className="text-muted-foreground/30"
      />
      {fill !== 'empty' && (
        <circle
          cx="5"
          cy="5"
          r="5"
          fill="currentColor"
          className="text-foreground"
          clipPath={fill === 'half' ? 'inset(0 50% 0 0)' : undefined}
        />
      )}
    </svg>
  );
}

function RatingDots({
  score,
  ariaLabel,
}: {
  score: number;
  ariaLabel: string;
}) {
  const clamped = Math.max(0, Math.min(RATING_MAX, score));
  const dots: Array<'full' | 'half' | 'empty'> = [];
  for (let i = 0; i < RATING_MAX; i++) {
    const remaining = clamped - i;
    if (remaining >= 1) dots.push('full');
    else if (remaining >= 0.5) dots.push('half');
    else dots.push('empty');
  }
  return (
    <span
      className="flex items-center gap-1"
      role="img"
      aria-label={ariaLabel}
    >
      {dots.map((fill, i) => (
        <RatingDot key={i} fill={fill} />
      ))}
    </span>
  );
}

function CostRow({ cost }: { cost: CostBucket }) {
  if (cost === 'Free') {
    return (
      <div className="flex items-center justify-between gap-6">
        <span className="text-muted-foreground">cost</span>
        <span className="font-medium text-emerald-600 dark:text-emerald-400">Free</span>
      </div>
    );
  }

  const filled = cost.length;

  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">cost</span>
      <span
        role="img"
        aria-label={`Cost rating: ${filled} out of ${COST_BUCKET_MAX}`}
        className="font-medium"
      >
        {'$'.repeat(filled)}
        <span className="text-muted-foreground/40">
          {'$'.repeat(COST_BUCKET_MAX - filled)}
        </span>
      </span>
    </div>
  );
}

function RatingRow({
  label,
  score,
  ariaLabel,
}: {
  label: string;
  score: number;
  ariaLabel: string;
}) {
  return (
    <div className="flex items-center justify-between gap-6">
      <span className="text-muted-foreground">{label}</span>
      <RatingDots score={score} ariaLabel={ariaLabel} />
    </div>
  );
}

function ModelMetadataCard({ entry }: { entry: ModelPickerOption }) {
  const unlockCopy = entry.locked
    ? entry.unlockHint === 'openai'
      ? 'Unlock with a plan, credits, an API key — or your OpenAI account.'
      : 'Unlock with a plan, credits, or an API key.'
    : entry.id === CAMEL_FREE_LLM_MODEL
      ? "Free and always included. Text-only — it can't see images. Comes with daily research and Oracle boosts powered by premium models."
      : null;

  return (
    <HoverCardContent side="right" align="start" sideOffset={8} className="w-64">
      <div className="space-y-2">
        <div className="font-medium">{entry.label}</div>
        <div className="h-px bg-border/60" />
        <div className="space-y-1.5">
          <CostRow cost={entry.cost} />
          <RatingRow
            label="intelligence"
            score={entry.intelligence}
            ariaLabel={`Intelligence rating: ${entry.intelligence} out of 5`}
          />
          <RatingRow
            label="speed"
            score={entry.speed}
            ariaLabel={`Speed rating: ${entry.speed} out of 5`}
          />
        </div>
        {unlockCopy ? (
          <p className="border-t border-border/60 pt-2 text-xs text-muted-foreground">
            {unlockCopy}
          </p>
        ) : null}
      </div>
    </HoverCardContent>
  );
}

export function ModelPicker({
  value,
  onValueChange,
  options,
  isOrgAdmin,
  onLockedModelSelect = () => {},
  onUnlockRequest = () => {},
  recentModelScope,
  disabled = false,
  manageModelsHref = '/settings/organization/models',
}: ModelPickerProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [openModelId, setOpenModelId] = useState<LlmModel | null>(null);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedEntry =
    options.find((option) => option.id === value) ?? MODEL_CATALOG[value];
  const unlockedOptions = options.filter((option) => !option.locked);
  const lockedOptions = options.filter((option) => option.locked);
  const orderedOptions = [...unlockedOptions, ...lockedOptions];
  const firstLockedIndex = unlockedOptions.length;
  const hasLockedOptions = lockedOptions.length > 0;

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
      <DropdownMenuContent align="start" className="w-64">
        {orderedOptions.map((entry, index) => {
          const isSelected = entry.id === value;
          return (
            <Fragment key={entry.id}>
              {index === firstLockedIndex ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="py-1 text-[0.65rem] font-medium uppercase tracking-wider">
                    Premium models
                  </DropdownMenuLabel>
                </>
              ) : null}
              <HoverCard
                open={openModelId === entry.id}
                openDelay={0}
                closeDelay={0}
              >
                <HoverCardTrigger asChild>
                  <DropdownMenuItem
                    onSelect={(event) => {
                      if (entry.locked) {
                        event?.preventDefault();
                        closeAllMetadata();
                        setMenuOpen(false);
                        onLockedModelSelect(entry.id);
                        return;
                      }
                      handleSelect(entry.id);
                    }}
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
                      entry.locked && 'opacity-60',
                    )}
                  >
                    <ModelLogo model={entry.id} size={16} className="size-4" />
                    <span className="min-w-0 flex-1 truncate">
                      {entry.label}
                    </span>
                    {entry.locked ? (
                      <Lock className="ml-auto size-3.5" aria-label="Locked" />
                    ) : isSelected ? (
                      <Check className="ml-auto size-3.5" />
                    ) : null}
                  </DropdownMenuItem>
                </HoverCardTrigger>
                {openModelId === entry.id && <ModelMetadataCard entry={entry} />}
              </HoverCard>
            </Fragment>
          );
        })}
        {hasLockedOptions ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="font-medium text-primary focus:text-primary"
              onSelect={() => {
                setMenuOpen(false);
                onUnlockRequest();
              }}
            >
              <LockOpen className="size-3.5" />
              <span className="flex-1">Unlock premium models</span>
              <span aria-hidden="true">→</span>
            </DropdownMenuItem>
          </>
        ) : null}
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
