import { useFetcher } from "react-router";
import { useEffect } from "react";
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
    error?: string;
  }>();
  const isCancelling = fetcher.state !== "idle";
  const succeeded =
    fetcher.state === "idle" &&
    fetcher.data &&
    !fetcher.data.error &&
    !fetcher.data.billingPortalUrl;

  useEffect(() => {
    if (fetcher.state !== "idle") return;
    if (fetcher.data?.billingPortalUrl) {
      window.location.assign(fetcher.data.billingPortalUrl);
      return;
    }
    if (succeeded && open) {
      onOpenChange(false);
    }
  }, [fetcher.data, fetcher.state, succeeded, open, onOpenChange]);

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
          {fetcher.data?.error ? (
            <p className="pt-2 text-sm text-destructive">
              {fetcher.data.error}
            </p>
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
