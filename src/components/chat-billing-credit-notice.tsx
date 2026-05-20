import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import type { BillingCreditStatus } from "@/lib/chat-credit-status";
import { cn } from "@/lib/utils";

const creditFormatter = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2,
});

function formatCredits(cents: number): string {
  return creditFormatter.format(Math.max(0, cents) / 100);
}

export function BillingCreditNotice({
  status,
  onOpenUsage,
  onTopUp,
  canTopUp = true,
  className,
}: {
  status: BillingCreditStatus;
  onOpenUsage: () => void;
  onTopUp: () => void;
  canTopUp?: boolean;
  className?: string;
}) {
  const usedCreditsCents = Math.max(
    0,
    status.totalCreditLimitCents - status.availableCreditsCents,
  );
  const usedPercent = Math.min(100, Math.max(0, status.usedPercent));

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
          "mx-auto w-full max-w-3xl px-4 pt-3 md:px-6",
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

  return (
    <div
      className={cn("mx-auto w-full max-w-3xl px-4 pt-3 md:px-6", className)}
    >
      <div className="rounded-lg border bg-card px-4 py-3 text-card-foreground">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-medium">
              {formatCredits(usedCreditsCents)} of{" "}
              {formatCredits(status.totalCreditLimitCents)} credits used this
              month
            </p>
            {status.hasByokProvider ? (
              <p className="mt-0.5 text-xs text-muted-foreground">
                This thread uses a hosted model that isn&apos;t covered by your
                API key, so it&apos;s drawing from hosted credits.
              </p>
            ) : null}
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenUsage}
            >
              View usage
            </Button>
            {canTopUp ? (
              <Button type="button" size="sm" onClick={onTopUp}>
                Top up
              </Button>
            ) : null}
          </div>
        </div>
        <Progress value={usedPercent} className="mt-2 h-2" />
      </div>
    </div>
  );
}
