'use client';

import { useEffect, useRef, useState } from 'react';
import { useFetcher } from 'react-router';
import { ArrowUpRight, ChevronDown, ChevronUp, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';

interface LegacyUserBannerProps {
  show: boolean;
  userId: string;
}

interface DismissFetcherData {
  success?: boolean;
  error?: string;
}

const SNOOZE_KEY_PREFIX = 'legacy_banner_snoozed_until:';
const SNOOZE_DURATION_MS = 60 * 60 * 1000;

function snoozeKey(userId: string) {
  return `${SNOOZE_KEY_PREFIX}${userId}`;
}

function readSnoozedUntil(userId: string): number | null {
  if (typeof window === 'undefined') return null;

  try {
    const storedValue = window.localStorage.getItem(snoozeKey(userId));
    if (!storedValue) return null;

    const snoozedUntil = Number(storedValue);
    if (!Number.isFinite(snoozedUntil) || snoozedUntil <= Date.now()) {
      window.localStorage.removeItem(snoozeKey(userId));
      return null;
    }

    return snoozedUntil;
  } catch {
    return null;
  }
}

function writeSnoozedUntil(userId: string, value: number | null) {
  if (typeof window === 'undefined') return;

  try {
    if (value === null) {
      window.localStorage.removeItem(snoozeKey(userId));
      return;
    }
    window.localStorage.setItem(snoozeKey(userId), String(value));
  } catch {
    // Ignore storage errors and keep the in-memory hide state.
  }
}

export function LegacyUserBanner({ show, userId }: LegacyUserBannerProps) {
  const fetcher = useFetcher<DismissFetcherData>();
  const [isExpanded, setIsExpanded] = useState(false);
  const [isDismissed, setIsDismissed] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(null);
  const dismissPendingRef = useRef(false);

  const isDismissing = fetcher.state !== 'idle';

  useEffect(() => {
    setSnoozedUntil(readSnoozedUntil(userId));
    setIsReady(true);
  }, [userId]);

  useEffect(() => {
    if (!snoozedUntil) return;

    const remainingMs = snoozedUntil - Date.now();
    if (remainingMs <= 0) {
      writeSnoozedUntil(userId, null);
      setSnoozedUntil(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      writeSnoozedUntil(userId, null);
      setSnoozedUntil(null);
    }, remainingMs);

    return () => window.clearTimeout(timeoutId);
  }, [snoozedUntil]);

  useEffect(() => {
    if (fetcher.state !== 'idle' || !dismissPendingRef.current) return;

    dismissPendingRef.current = false;
    if (fetcher.data?.error) {
      setIsDismissed(false);
      toast.error(fetcher.data.error);
    }
  }, [fetcher.state, fetcher.data]);

  function handleClose() {
    const nextSnoozedUntil = Date.now() + SNOOZE_DURATION_MS;
    writeSnoozedUntil(userId, nextSnoozedUntil);
    setSnoozedUntil(nextSnoozedUntil);
    setIsExpanded(false);
  }

  function handleDismiss() {
    if (isDismissing || isDismissed) return;

    writeSnoozedUntil(userId, null);
    setSnoozedUntil(null);
    dismissPendingRef.current = true;
    setIsDismissed(true);
    setIsExpanded(false);
    fetcher.submit({}, { method: 'post', action: '/api/legacy-banner/dismiss' });
  }

  if (!show || !isReady || isDismissed || Boolean(snoozedUntil)) return null;

  return (
    <div className="fixed bottom-4 right-4 z-50 w-[min(20rem,calc(100vw-2rem))] animate-in fade-in-0 slide-in-from-bottom-2 duration-200">
      <Collapsible open={isExpanded} onOpenChange={setIsExpanded}>
        <div className="overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg">
          <div className="flex items-start gap-2 p-3">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                className="flex min-w-0 flex-1 cursor-pointer items-start gap-2 rounded-md text-left outline-none transition-colors hover:text-foreground/90 focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                <span
                  aria-hidden="true"
                  className="legacy-banner-wave mt-0.5 inline-block shrink-0 text-sm leading-none"
                >
                  👋
                </span>
                <span className="min-w-0 flex-1 text-sm font-medium leading-5">
                  Things look different? Here&apos;s why
                </span>
                {isExpanded ? (
                  <ChevronUp className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                ) : (
                  <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                )}
              </button>
            </CollapsibleTrigger>

            <button
              type="button"
              onClick={handleClose}
              aria-label="Hide legacy user notice for now"
              className="rounded-md p-1 text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-50"
            >
              <X className="size-4" />
            </button>
          </div>

          <CollapsibleContent className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:animate-none">
            <div className="space-y-3 border-t border-border px-3 pb-3 pt-3">
              <p className="text-sm leading-5 text-muted-foreground">
                You&apos;re on camelAI.dev, the new camelAI. What started as an
                analytics tool has evolved into a coding agent with a
                persistent computer that can build, deploy, and automate
                anything.
              </p>
              <p className="text-sm leading-5 text-muted-foreground">
                Your existing dashboards and data connections are still live.
                Nothing is going away.
              </p>

              <div className="flex flex-col gap-2">
                <Button
                  asChild
                  className="h-auto w-full justify-between whitespace-normal px-3 py-2 text-left"
                >
                  <a
                    href="https://app.camelai.com"
                    target="_blank"
                    rel="noopener"
                  >
                    <span>Take me to my analytics workspace</span>
                    <ArrowUpRight className="size-4 shrink-0" />
                  </a>
                </Button>

                <Button
                  type="button"
                  variant="outline"
                  onClick={handleDismiss}
                  disabled={isDismissing}
                  className="h-auto w-full whitespace-normal px-3 py-2"
                >
                  Got it, don&apos;t show again
                </Button>
              </div>
            </div>
          </CollapsibleContent>
        </div>
      </Collapsible>
    </div>
  );
}
