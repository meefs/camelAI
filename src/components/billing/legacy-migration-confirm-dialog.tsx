import { ArrowRight, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { BillingPlan } from "@/types";

type MigrationPlan = Exclude<BillingPlan, "free" | "enterprise">;

export interface LegacyMigrationPreview {
  plan: MigrationPlan;
  seatCount: number;
  currency: string;
  monthlyPriceCents: number | null;
  amountDueTodayCents: number | null;
  legacyCreditCents: number | null;
  newPlanProrationCents: number | null;
  includedCreditCents: number;
}

export interface LegacyMigrationConfirmation {
  billingPortalUrl: string;
  preview: LegacyMigrationPreview | null;
}

interface LegacyMigrationConfirmDialogProps {
  confirmation: LegacyMigrationConfirmation | null;
  onOpenChange: (open: boolean) => void;
  onContinue: () => void;
}

export function LegacyMigrationConfirmDialog({
  confirmation,
  onOpenChange,
  onContinue,
}: LegacyMigrationConfirmDialogProps) {
  return (
    <Dialog
      open={Boolean(confirmation)}
      onOpenChange={(open) => onOpenChange(open)}
    >
      <DialogContent className="gap-6 p-8 sm:max-w-2xl">
        <DialogHeader className="gap-4">
          <DialogTitle className="text-2xl font-semibold">
            Confirm your subscription switch
          </DialogTitle>
          <DialogDescription className="text-base leading-7">
            Your previous camelAI subscription will be replaced by your new
            plan. It will not renew or bill again next month after you confirm
            the switch in Stripe.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/30 p-6">
          <p className="flex items-start gap-4 text-base leading-7">
            <CheckCircle2
              className="mt-1 size-5 shrink-0 text-primary"
              aria-hidden="true"
            />
            <span>
              Stripe will cancel the old legacy subscription as part of this
              update, not create a second subscription.
            </span>
          </p>
        </div>

        <DialogFooter className="gap-4">
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
          >
            Back
          </Button>
          <Button type="button" onClick={onContinue}>
            Continue to Stripe
            <ArrowRight className="size-4" aria-hidden="true" />
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
