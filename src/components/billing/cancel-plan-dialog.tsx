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
  const fetcher = useFetcher();
  const isCancelling = fetcher.state !== "idle";
  const succeeded =
    fetcher.state === "idle" &&
    fetcher.data &&
    !(fetcher.data as { error?: string }).error;

  useEffect(() => {
    if (succeeded && open) {
      onOpenChange(false);
    }
  }, [succeeded, open, onOpenChange]);

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
