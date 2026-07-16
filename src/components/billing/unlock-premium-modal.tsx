import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { isLlmModelCoveredByOpenAiSubscription } from "@/lib/llm-provider-config";
import type { LlmModel } from "@/types";

export interface UnlockPremiumModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerModel: LlmModel | null;
  isOrgAdmin: boolean;
  orgId: string;
  onSeePlans: () => void;
  onTopUp: () => void;
  onAddKey: () => void;
  onOpenAiSignIn: () => void;
}

function AdminAction({
  isOrgAdmin,
  label,
  onClick,
  recommended = false,
}: {
  isOrgAdmin: boolean;
  label: string;
  onClick: () => void;
  recommended?: boolean;
}) {
  return isOrgAdmin ? (
    <Button
      type="button"
      variant={recommended ? "default" : "outline"}
      size="sm"
      onClick={onClick}
    >
      {label}
    </Button>
  ) : (
    <span className="shrink-0 pt-1 text-xs text-muted-foreground">
      Ask an org admin
    </span>
  );
}

export function UnlockPremiumModal({
  open,
  onOpenChange,
  triggerModel,
  isOrgAdmin,
  orgId,
  onSeePlans,
  onTopUp,
  onAddKey,
  onOpenAiSignIn,
}: UnlockPremiumModalProps) {
  const isOpenAiSubscriptionTrigger = Boolean(
    triggerModel && isLlmModelCoveredByOpenAiSubscription(triggerModel),
  );
  const triggerLabel = triggerModel
    ? (MODEL_CATALOG[triggerModel]?.label ?? triggerModel)
    : "Claude and GPT";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Unlock premium models</DialogTitle>
          <DialogDescription>
            Camel Free is always included. Premium models like {triggerLabel} need
            one of these:
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6" data-org-id={orgId}>
          <div className="space-y-4">
            <span className="inline-block rounded-none bg-primary/10 px-2 py-1 text-xs font-medium uppercase tracking-wide text-primary">
              Pay through camelAI
            </span>
            <div className="relative">
              <Badge
                variant="default"
                className="absolute top-0 left-4 z-10 -translate-y-1/2"
              >
                Recommended
              </Badge>
              <Card
                className="py-0 ring-2 ring-primary"
                data-testid="unlock-method-subscribe"
              >
                <CardContent className="flex items-start gap-3 p-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium">Subscribe</p>
                      <span className="text-xs text-muted-foreground">
                        from $10/mo
                      </span>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      Monthly model credits matching your plan price, plus more
                      apps, automations, and storage.
                    </p>
                  </div>
                  <AdminAction
                    isOrgAdmin={isOrgAdmin}
                    label="See plans"
                    onClick={onSeePlans}
                    recommended
                  />
                </CardContent>
              </Card>
            </div>

            <div
              className="flex items-start justify-between gap-3 px-1"
              data-testid="unlock-method-credits"
            >
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Buy credits</p>
                <p className="text-sm text-muted-foreground">
                  Prepaid, pay as you go. No subscription.
                </p>
              </div>
              <AdminAction
                isOrgAdmin={isOrgAdmin}
                label="Top up"
                onClick={onTopUp}
              />
            </div>
          </div>

          <div className="space-y-3 pt-1">
            <span className="inline-block rounded-none bg-primary/10 px-2 py-1 text-xs font-medium uppercase tracking-wide text-primary">
              Use what you already pay for
            </span>
            <div
              className="flex items-start justify-between gap-3 px-1"
              data-testid="unlock-method-openai"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-sm font-medium">Sign in with OpenAI</p>
                  {isOpenAiSubscriptionTrigger ? (
                    <Badge variant="secondary">Best value for GPT models</Badge>
                  ) : null}
                </div>
                <p className="text-sm text-muted-foreground">
                  Use your ChatGPT plan&apos;s allowance — no extra cost.
                </p>
              </div>
              <AdminAction
                isOrgAdmin={isOrgAdmin}
                label="Sign in"
                onClick={onOpenAiSignIn}
              />
            </div>

            <Separator />

            <div
              className="flex items-start justify-between gap-3 px-1"
              data-testid="unlock-method-key"
            >
              <div className="min-w-0 space-y-1">
                <p className="text-sm font-medium">Use your own API key</p>
                <p className="text-sm text-muted-foreground">
                  Anthropic, OpenAI, OpenRouter, Bedrock, or a custom endpoint.
                </p>
              </div>
              <AdminAction
                isOrgAdmin={isOrgAdmin}
                label="Add key"
                onClick={onAddKey}
              />
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
