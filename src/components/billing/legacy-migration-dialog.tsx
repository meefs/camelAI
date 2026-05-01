import { ArrowRight } from "lucide-react";
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

export interface LegacyMigrationDialogData {
  eligible: boolean;
  customerId: string | null;
  activeLegacySubscriptionCount: number;
  defaultPlan: MigrationPlan;
}

export interface LegacyMigrationDialogPrimaryAction {
  label?: string;
  onClick: () => void;
}

interface LegacyMigrationDialogProps {
  migration: LegacyMigrationDialogData | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  primaryAction?: LegacyMigrationDialogPrimaryAction;
}

const SUPPORT_MAILTO =
  "mailto:support@camelai.com?subject=Legacy%20subscription%20migration";

export function LegacyMigrationDialog({
  migration,
  open,
  onOpenChange,
  primaryAction,
}: LegacyMigrationDialogProps) {
  if (!migration?.eligible) return null;

  const requiresManualReview = migration.activeLegacySubscriptionCount > 1;

  const handlePrimary = () => {
    if (primaryAction) {
      primaryAction.onClick();
      return;
    }
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader className="gap-3">
          <DialogTitle className="text-lg font-semibold">
            {requiresManualReview
              ? "Let's migrate this one manually."
              : "Welcome back. camelAI is a new product now."}
          </DialogTitle>
          <DialogDescription className="space-y-3 text-sm text-muted-foreground">
            {requiresManualReview ? (
              <span className="block">
                Your account has more than one active subscription on the
                original camelAI. To make sure nothing gets billed twice, we'd
                like to move you over directly rather than through self-checkout.
              </span>
            ) : (
              <>
                <span className="block">
                  You're paying for our original analytics tool. We've rebuilt
                  camelAI as a coding-agent platform — same team, new product.
                </span>
                <span className="block">
                  When you pick a paid plan on the next screen, Stripe will:
                </span>
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        {!requiresManualReview ? (
          <ul className="space-y-2 text-sm text-foreground/90">
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 text-primary">
                ✓
              </span>
              <span>Cancel your existing subscription</span>
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 text-primary">
                ✓
              </span>
              <span>
                Show the unused legacy subscription credit and amount due today
                before you confirm
              </span>
            </li>
            <li className="flex items-start gap-2">
              <span aria-hidden="true" className="mt-0.5 text-primary">
                ✓
              </span>
              <span>
                Prevent the old subscription from renewing or billing again next
                month
              </span>
            </li>
          </ul>
        ) : null}

        <div className="border-t pt-3 text-sm text-muted-foreground">
          Still need the analytics tool? It's still live at{" "}
          <a
            href="https://app.camelai.com"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-3 hover:text-foreground"
          >
            app.camelai.com
          </a>
          .
        </div>

        <DialogFooter>
          {requiresManualReview ? (
            <>
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
              >
                Not now
              </Button>
              <Button asChild>
                <a href={SUPPORT_MAILTO}>Contact support</a>
              </Button>
            </>
          ) : (
            <Button type="button" onClick={handlePrimary}>
              {primaryAction?.label ?? "See plans"}
              <ArrowRight className="size-4" aria-hidden="true" />
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
