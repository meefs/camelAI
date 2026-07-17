import { useEffect } from "react";
import { useFetcher } from "react-router";
import { PlanPicker, type PlanPickerCta } from "./plan-picker";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const BOOK_DEMO_URL = "https://book-demo--camelai-team-d9e.camelai.app/";

interface CheckoutResponse {
  checkoutUrl?: string;
  error?: string;
}

export interface PlanUpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTopUp: () => void;
  onAddKey: () => void;
  onOpenAiSignIn: () => void;
}

function isSubscriptionPlan(
  value: string,
): value is "starter" | "pro" | "team" {
  return value === "starter" || value === "pro" || value === "team";
}

export function PlanUpgradeDialog({
  open,
  onOpenChange,
  onTopUp,
  onAddKey,
  onOpenAiSignIn,
}: PlanUpgradeDialogProps) {
  const checkoutFetcher = useFetcher<CheckoutResponse>();
  const pendingValue = String(checkoutFetcher.formData?.get("plan") ?? "");
  const pendingPlan = isSubscriptionPlan(pendingValue) ? pendingValue : null;
  const isStartingCheckout = checkoutFetcher.state !== "idle";

  useEffect(() => {
    if (checkoutFetcher.state !== "idle") return;
    const checkoutUrl = checkoutFetcher.data?.checkoutUrl;
    if (checkoutUrl) window.location.assign(checkoutUrl);
  }, [checkoutFetcher.data, checkoutFetcher.state]);

  const openAlternative = (callback: () => void) => {
    onOpenChange(false);
    callback();
  };

  const handleSelectPlan = (cta: PlanPickerCta) => {
    if (cta.kind === "subscribe") {
      if (isStartingCheckout) return;
      checkoutFetcher.submit(
        { plan: cta.plan },
        {
          method: "post",
          action: "/api/billing/start-subscription",
        },
      );
      return;
    }
    if (cta.kind === "contact") {
      window.open(BOOK_DEMO_URL, "_blank", "noopener,noreferrer");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>Choose your plan</DialogTitle>
          <DialogDescription>
            You&apos;re on the Free plan — camelCode included forever. Upgrade
            for premium models, more apps, and automations.
          </DialogDescription>
        </DialogHeader>

        {checkoutFetcher.data?.error ? (
          <Alert variant="destructive">
            <AlertDescription>{checkoutFetcher.data.error}</AlertDescription>
          </Alert>
        ) : null}

        <PlanPicker
          heading={null}
          showFooter={false}
          pendingPlan={isStartingCheckout ? pendingPlan : null}
          onSelectPlan={handleSelectPlan}
        />

        <div className="flex flex-wrap items-center justify-center gap-x-1 text-sm text-muted-foreground">
          <span>Not ready to subscribe?</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1"
            onClick={() => openAlternative(onTopUp)}
          >
            Buy credits as you go
          </Button>
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1"
            onClick={() => openAlternative(onAddKey)}
          >
            Add an API key
          </Button>
          <span aria-hidden="true">·</span>
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1"
            onClick={() => openAlternative(onOpenAiSignIn)}
          >
            Sign in with OpenAI
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
