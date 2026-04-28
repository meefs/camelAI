import { Link } from "react-router";
import { CreditCard, Info, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useIsMobile } from "@/hooks/use-mobile";

interface FreeTierModalProps {
  open: boolean;
  onClose: () => void;
}

const AI_PROVIDER_SETTINGS_PATH = "/settings/organization/ai-provider";
const BILLING_SETTINGS_PATH = "/settings/organization/billing";

function BillingCard({ onClose }: { onClose: () => void }) {
  return (
    <div className="space-y-3 rounded-lg border bg-muted/50 p-4">
      <div className="flex gap-3">
        <CreditCard className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-sm text-muted-foreground">
          Hosted usage now requires a subscription. Your first 7 days include
          capped credits, and after that usage is deducted from your credit
          balance in{" "}
          <Link
            to={BILLING_SETTINGS_PATH}
            onClick={onClose}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Billing
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function ApiKeyCallout({ onClose }: { onClose: () => void }) {
  return (
    <div className="rounded-lg border border-primary/20 bg-primary/5 p-4">
      <div className="flex gap-3">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-primary" />
        <p className="text-sm text-muted-foreground">
          Want camelAI to run turns with your own provider credentials?{" "}
          <Link
            to={AI_PROVIDER_SETTINGS_PATH}
            onClick={onClose}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Add your own API key.
          </Link>{" "}
          Paid access still gates usage, but BYOK turns do not consume camelAI
          credits. Your provider may also bill the underlying model usage.
        </p>
      </div>
    </div>
  );
}

function ModalBody({ onClose }: { onClose: () => void }) {
  return (
    <>
      <BillingCard onClose={onClose} />
      <ApiKeyCallout onClose={onClose} />
    </>
  );
}

function ModalActions({ onClose }: { onClose: () => void }) {
  return (
    <Button variant="outline" onClick={onClose} className="w-full">
      Got it
    </Button>
  );
}

export function FreeTierModal({ open, onClose }: FreeTierModalProps) {
  const isMobile = useIsMobile();
  const preventDismiss = (event: Event) => {
    event.preventDefault();
  };

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={() => {}}>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          className="rounded-t-2xl"
          onEscapeKeyDown={preventDismiss}
          onInteractOutside={preventDismiss}
        >
          <SheetHeader className="gap-3">
            <div className="flex items-center gap-2">
              <Info className="size-5 text-primary" />
              <SheetTitle className="text-base font-semibold">
                A quick heads up on billing
              </SheetTitle>
            </div>
            <p className="text-sm text-muted-foreground">
              camelAI now uses subscription access plus usage credits for hosted
              models.
            </p>
          </SheetHeader>
          <div className="space-y-4 px-6 pb-2">
            <ModalBody onClose={onClose} />
          </div>
          <SheetFooter>
            <ModalActions onClose={onClose} />
          </SheetFooter>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={open} onOpenChange={() => {}}>
      <DialogContent
        showCloseButton={false}
        className="sm:max-w-md"
        onEscapeKeyDown={preventDismiss}
        onInteractOutside={preventDismiss}
      >
        <DialogHeader className="gap-3">
          <div className="flex items-center gap-2">
            <Info className="size-5 text-primary" />
            <DialogTitle className="text-base font-semibold">
              A quick heads up on billing
            </DialogTitle>
          </div>
          <p className="text-sm text-muted-foreground">
            camelAI now uses subscription access plus usage credits for hosted
            models.
          </p>
        </DialogHeader>
        <div className="space-y-4">
          <ModalBody onClose={onClose} />
        </div>
        <DialogFooter>
          <ModalActions onClose={onClose} />
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
