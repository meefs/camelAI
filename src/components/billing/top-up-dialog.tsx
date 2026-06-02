import { Form } from "react-router";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface TopUpDialogPack {
  id: string;
  creditsLabel: string | null;
  priceLabel: string | null;
}

interface TopUpDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packs: TopUpDialogPack[];
  action?: string;
  returnTo?: string;
  loading?: boolean;
  canTopUp?: boolean;
  unavailableReason?: string | null;
}

export function TopUpDialog({
  open,
  onOpenChange,
  packs,
  action,
  returnTo,
  loading = false,
  canTopUp = true,
  unavailableReason = null,
}: TopUpDialogProps) {
  const showUnavailable = !loading && (!canTopUp || packs.length === 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Top up credits</DialogTitle>
          <DialogDescription>
            Pick a credit pack. You'll be redirected to Stripe Checkout.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          {loading && packs.length === 0 ? (
            <div className="flex items-center justify-between gap-3 rounded-md border px-3 py-2">
              <div className="space-y-1">
                <Skeleton className="h-4 w-24" />
                <Skeleton className="h-3 w-16" />
              </div>
              <Skeleton className="h-6 w-12" />
            </div>
          ) : null}
          {showUnavailable ? (
            <div className="rounded-md border bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
              {unavailableReason ?? "Top-up is not available right now."}
            </div>
          ) : null}
          {!showUnavailable
            ? packs.map((pack) => (
                <Form
                  key={pack.id}
                  method="post"
                  action={action}
                  className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
                >
                  <input type="hidden" name="intent" value="buyCredits" />
                  <input type="hidden" name="priceId" value={pack.id} />
                  {returnTo ? (
                    <input type="hidden" name="returnTo" value={returnTo} />
                  ) : null}
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">
                      {pack.creditsLabel ?? "Credits"}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {pack.priceLabel ?? pack.id}
                    </p>
                  </div>
                  <Button type="submit" size="sm" disabled={loading}>
                    Buy
                  </Button>
                </Form>
              ))
            : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
