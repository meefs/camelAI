import { useEffect } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { formatDate } from "@/lib/hydration-safe-datetime";

interface CancelPlanDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  planLabel: string;
  periodEndLabel: string | null;
}

export function CancelPlanDialog({
  open,
  onOpenChange,
  planLabel,
  periodEndLabel,
}: CancelPlanDialogProps) {
  const fetcher = useFetcher<{
    billingPortalUrl?: string;
    cancellationScheduled?: boolean;
    cancellationDateMs?: number | null;
    error?: string;
  }>();
  const revalidator = useRevalidator();
  const isCancelling = fetcher.state !== "idle";
  const cancellationScheduled = fetcher.data?.cancellationScheduled === true;
  const errorMessage =
    fetcher.data?.error && !cancellationScheduled ? fetcher.data.error : null;

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (fetcher.data?.billingPortalUrl) {
      window.location.assign(fetcher.data.billingPortalUrl);
      return;
    }
    if (cancellationScheduled && open) {
      onOpenChange(false);
      revalidator.revalidate();
      toast.success(
        fetcher.data?.cancellationDateMs
          ? `Plan cancels ${formatDate(fetcher.data.cancellationDateMs)}.`
          : "Plan cancellation is scheduled.",
      );
    }
  }, [
    cancellationScheduled,
    fetcher.data,
    fetcher.state,
    open,
    onOpenChange,
    revalidator,
  ]);

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!isCancelling) onOpenChange(next);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            Cancel your {planLabel} subscription?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {periodEndLabel
              ? `Your plan stays active until ${periodEndLabel} and then switches to Free.`
              : "Your plan stays active until the end of the current billing period and then switches to Free."}
          </AlertDialogDescription>
          {errorMessage ? (
            <p className="pt-2 text-sm text-destructive">{errorMessage}</p>
          ) : null}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isCancelling}>
            Keep plan
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={(event) => {
              event.preventDefault();
              fetcher.submit(
                { intent: "cancelSubscription" },
                { method: "post" },
              );
            }}
            disabled={isCancelling}
          >
            {isCancelling ? "Cancelling…" : "Cancel plan"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
