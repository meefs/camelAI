import { useEffect, useState } from "react";
import { Info, X } from "lucide-react";
import { Link } from "react-router";
import { Button } from "@/components/ui/button";
import {
  shouldShowModelFallbackNotice,
  type ChatAgentModelFallbackNotice,
} from "@/lib/chat-agent-state";
import {
  isLlmModel,
  isLlmModelCoveredByOpenAiSubscription,
} from "@/lib/llm-provider-config";
import { MODEL_CATALOG } from "@/lib/model-catalog";
import { cn } from "@/lib/utils";

function dismissedStorageKey(noticeId: string): string {
  return `model-fallback-dismissed:${noticeId}`;
}

export function ModelFallbackBanner({
  notice,
  activeModel,
  isOrgAdmin,
  onTopUp,
  onUpgrade,
  onAddKey,
  onOpenAiSignIn,
  className,
}: {
  notice: ChatAgentModelFallbackNotice | null | undefined;
  activeModel: string | null | undefined;
  isOrgAdmin: boolean;
  onTopUp: () => void;
  onUpgrade: () => void;
  onAddKey: () => void;
  onOpenAiSignIn: () => void;
  className?: string;
}) {
  const [dismissed, setDismissed] = useState(false);
  const [ready, setReady] = useState(false);
  const noticeId = notice?.id ?? null;

  useEffect(() => {
    if (!noticeId) {
      setDismissed(false);
      setReady(true);
      return;
    }
    try {
      setDismissed(
        window.localStorage.getItem(dismissedStorageKey(noticeId)) !== null,
      );
    } catch {
      setDismissed(false);
    }
    setReady(true);
  }, [noticeId]);

  if (
    !ready ||
    dismissed ||
    !shouldShowModelFallbackNotice(notice, activeModel)
  ) {
    return null;
  }

  const fromModelLabel = isLlmModel(notice.fromModel)
    ? MODEL_CATALOG[notice.fromModel].label
    : notice.fromModel;
  const creditsExhausted = notice.reason === "hosted_credits_exhausted";

  const dismiss = () => {
    try {
      window.localStorage.setItem(dismissedStorageKey(notice.id), "1");
    } catch {
      // Keep dismissal in memory when storage is unavailable.
    }
    setDismissed(true);
  };

  return (
    <div className={cn("w-full", className)} role="status">
      <div className="relative overflow-hidden rounded-lg border bg-card px-3 py-3 text-card-foreground">
        <div className="flex items-start gap-2 pr-8">
          <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="space-y-0.5">
              <p className="text-sm font-semibold">
                {creditsExhausted
                  ? "Monthly credits used up — switched to Camel Free."
                  : "Your subscription is unavailable — switched to Camel Free."}
              </p>
              {creditsExhausted && isOrgAdmin ? (
                <p className="text-xs text-muted-foreground">
                  Get back on {fromModelLabel}:
                </p>
              ) : !isOrgAdmin ? (
                <p className="text-xs text-muted-foreground">
                  Ask an org admin to top up or upgrade.
                </p>
              ) : null}
            </div>

            {isOrgAdmin ? (
              <div className="flex flex-wrap gap-2">
                {creditsExhausted ? (
                  <>
                    {isLlmModel(notice.fromModel) &&
                    isLlmModelCoveredByOpenAiSubscription(notice.fromModel) ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={onOpenAiSignIn}
                      >
                        Sign in with OpenAI
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onTopUp}
                    >
                      Top up credits
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onUpgrade}
                    >
                      Upgrade plan
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onAddKey}
                    >
                      Use API key
                    </Button>
                  </>
                ) : (
                  <>
                    <Button asChild variant="outline" size="sm">
                      <Link to="/settings/organization/billing">Fix payment</Link>
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={onAddKey}
                    >
                      Use API key
                    </Button>
                  </>
                )}
              </div>
            ) : null}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="absolute right-1.5 top-1.5"
          aria-label="Dismiss model fallback notice"
          onClick={dismiss}
        >
          <X className="size-4" />
        </Button>
      </div>
    </div>
  );
}
