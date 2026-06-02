import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import {
  activeLowCreditTier,
  LOW_CREDIT_THRESHOLDS_CENTS,
  shouldShowLowCreditAlert,
  type BillingCreditStatus,
} from "@/lib/chat-credit-status";
import { cn } from "@/lib/utils";

const DISMISSED_TIER_KEY_PREFIX = "low_credits_alert_dismissed_tier:";
const creditAmountFormatter = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function formatCreditNumber(cents: number): string {
  return creditAmountFormatter.format(Math.max(0, cents) / 100);
}

function formatCreditLabel(cents: number): string {
  return `${formatCreditNumber(cents)} credits`;
}

function storageKey(userId: string, orgId: string): string {
  return `${DISMISSED_TIER_KEY_PREFIX}${userId}:${orgId}`;
}

function parseStoredDismissedTier(value: string | null): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return LOW_CREDIT_THRESHOLDS_CENTS.some((tier) => tier === parsed)
    ? parsed
    : null;
}

function readDismissedTier(userId: string | null, orgId: string | null): number | null {
  if (typeof window === "undefined" || !userId || !orgId) return null;

  try {
    const key = storageKey(userId, orgId);
    const value = window.localStorage.getItem(key);
    const parsed = parseStoredDismissedTier(value);
    if (value && parsed === null) {
      window.localStorage.removeItem(key);
    }
    return parsed;
  } catch {
    return null;
  }
}

function writeDismissedTier(
  userId: string | null,
  orgId: string | null,
  tier: number | null,
): void {
  if (typeof window === "undefined" || !userId || !orgId) return;

  try {
    const key = storageKey(userId, orgId);
    if (tier === null) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, String(tier));
  } catch {
    // Ignore storage errors and keep the in-memory state for this tab.
  }
}

export function BillingCreditNotice({
  status,
  onOpenUsage,
  onTopUp,
  canTopUp = true,
  userId = null,
  orgId = null,
  className,
}: {
  status: BillingCreditStatus;
  onOpenUsage: () => void;
  onTopUp: () => void;
  canTopUp?: boolean;
  userId?: string | null;
  orgId?: string | null;
  className?: string;
}) {
  const activeTier = status.isExhausted
    ? null
    : activeLowCreditTier(status.availableCreditsCents);
  const [dismissedTier, setDismissedTier] = useState<number | null>(null);
  const [isReady, setIsReady] = useState(false);
  const [isDismissing, setIsDismissing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const storageKeyForNotice = useMemo(
    () => (userId && orgId ? storageKey(userId, orgId) : null),
    [userId, orgId],
  );

  useEffect(() => {
    setDismissedTier(readDismissedTier(userId, orgId));
    setIsDismissing(false);
    setIsReady(true);
  }, [userId, orgId]);

  useEffect(() => {
    if (!storageKeyForNotice || typeof window === "undefined") return;

    function handleStorage(event: StorageEvent) {
      if (event.key !== storageKeyForNotice) return;
      setDismissedTier(parseStoredDismissedTier(event.newValue));
      setIsDismissing(false);
    }

    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, [storageKeyForNotice]);

  useEffect(() => {
    if (!isReady || activeTier !== null) return;
    writeDismissedTier(userId, orgId, null);
    setDismissedTier(null);
    setIsDismissing(false);
  }, [activeTier, isReady, orgId, userId]);

  useEffect(() => {
    if (!activeTier || !shouldShowLowCreditAlert(activeTier, dismissedTier)) {
      return;
    }
    setIsDismissing(false);
  }, [activeTier, dismissedTier]);

  useEffect(() => {
    if (!isDismissing || typeof window === "undefined") return;
    const timeoutId = window.setTimeout(() => setIsDismissing(false), 180);
    return () => window.clearTimeout(timeoutId);
  }, [isDismissing]);

  const handleDismiss = useCallback(() => {
    if (!activeTier) return;
    writeDismissedTier(userId, orgId, activeTier);
    setDismissedTier(activeTier);
    setIsDismissing(true);
  }, [activeTier, orgId, userId]);

  const shouldShowLowRail =
    isReady &&
    activeTier !== null &&
    (isDismissing || shouldShowLowCreditAlert(activeTier, dismissedTier));

  useEffect(() => {
    if (!shouldShowLowRail || activeTier === null) {
      setAnnouncement("");
      return;
    }
    setAnnouncement(
      `Low credit warning. Balance below ${formatCreditLabel(activeTier)}.`,
    );
  }, [activeTier, shouldShowLowRail]);

  const liveRegion = (
    <span className="sr-only" role="status" aria-live="polite">
      {announcement}
    </span>
  );

  if (status.isExhausted) {
    const description = status.hasByokProvider
      ? canTopUp
        ? "This thread uses a hosted model that isn't covered by your API key. Top up to keep going, or switch to a model your key supports."
        : "This thread uses a hosted model that isn't covered by your API key. Ask an organization admin to top up credits, or switch to a model your key supports."
      : canTopUp
        ? "Top up to keep going, or use your own API key."
        : "Ask an organization admin to top up credits, or use your own API key.";

    return (
      <div
        className={cn(
          "w-full",
          className,
        )}
      >
        <div className="rounded-lg bg-foreground px-4 py-3 text-background">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-semibold">
                You&apos;re out of hosted credits this month
              </p>
              <p className="mt-0.5 text-xs text-background/80">
                {description}
              </p>
            </div>
            <div className="flex shrink-0 gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="border-background/40 bg-transparent text-background hover:bg-background/10 hover:text-background"
                onClick={onOpenUsage}
              >
                View usage
              </Button>
              {canTopUp ? (
                <Button
                  type="button"
                  size="sm"
                  className="bg-background text-foreground hover:bg-background/90"
                  onClick={onTopUp}
                >
                  Top up
                </Button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!shouldShowLowRail) return liveRegion;

  const remainingPercentOfFive = Math.min(
    100,
    Math.max(0, (status.availableCreditsCents / 500) * 100),
  );
  const formattedAvailable = formatCreditNumber(status.availableCreditsCents);

  return (
    <div
      className={cn(
        "w-full",
        isDismissing
          ? "animate-out fade-out-0 slide-out-to-bottom-1 duration-150 motion-reduce:animate-none"
          : "animate-in fade-in-0 slide-in-from-bottom-1 duration-200 motion-reduce:animate-none",
        className,
      )}
      onAnimationEnd={() => {
        if (isDismissing) setIsDismissing(false);
      }}
    >
      <div className="relative overflow-hidden rounded-lg border bg-card px-3 py-2.5 text-card-foreground">
        {liveRegion}
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold text-foreground">
              {formattedAvailable}
            </span>
            <span className="text-muted-foreground"> credits left</span>
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground"
              onClick={onOpenUsage}
            >
              View usage
            </Button>
            {canTopUp ? (
              <Button type="button" size="sm" onClick={onTopUp}>
                Top up
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="text-muted-foreground hover:text-foreground"
              aria-label="Dismiss low credit alert"
              onClick={handleDismiss}
            >
              <X className="size-3" />
            </Button>
          </div>
        </div>
        <Progress
          value={remainingPercentOfFive}
          aria-label="Credits remaining"
          aria-valuetext={`${formattedAvailable} of ${formatCreditLabel(500)}`}
          className="absolute inset-x-0 bottom-0 rounded-none"
        />
      </div>
    </div>
  );
}
