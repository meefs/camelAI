import { Form } from "react-router";
import { Button } from "@/components/ui/button";
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
}

export function TopUpDialog({ open, onOpenChange, packs }: TopUpDialogProps) {
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
          {packs.map((pack) => (
            <Form
              key={pack.id}
              method="post"
              className="flex items-center justify-between gap-3 rounded-md border px-3 py-2"
            >
              <input type="hidden" name="intent" value="buyCredits" />
              <input type="hidden" name="priceId" value={pack.id} />
              <div className="space-y-0.5">
                <p className="text-sm font-medium">
                  {pack.creditsLabel ?? "Credits"}
                </p>
                <p className="text-xs text-muted-foreground">
                  {pack.priceLabel ?? pack.id}
                </p>
              </div>
              <Button type="submit" size="sm">
                Buy
              </Button>
            </Form>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
