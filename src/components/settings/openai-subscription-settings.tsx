import { useEffect, useState } from "react";
import { useFetcher, useRevalidator } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  OpenAiSignInFlow,
  type OpenAiSubscriptionActionResponse,
} from "@/components/billing/openai-sign-in-dialog";

export interface OpenAiSubscriptionPublic {
  accountEmail: string | null;
  planType: string | null;
  updatedAt: number;
}

export function OpenAiSubscriptionSettings({
  orgId,
  subscription,
}: {
  orgId: string;
  subscription: OpenAiSubscriptionPublic | null;
}) {
  const fetcher = useFetcher<OpenAiSubscriptionActionResponse>();
  const revalidator = useRevalidator();
  const [isDeleting, setIsDeleting] = useState(false);
  const isSubmitting = fetcher.state !== "idle";
  const action = `/api/orgs/${orgId}/llm-provider`;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !isDeleting) return;
    if (fetcher.data.error) {
      setIsDeleting(false);
      toast.error(fetcher.data.error);
      return;
    }
    if (fetcher.data.success) {
      setIsDeleting(false);
      toast.success("OpenAI subscription disconnected.");
      revalidator.revalidate();
    }
  }, [fetcher.data, fetcher.state, isDeleting, revalidator]);

  const disconnect = () => {
    setIsDeleting(true);
    fetcher.submit(
      { intent: "deleteOpenAiSubscription" },
      { method: "POST", action, encType: "application/json" },
    );
  };

  return (
    <section className="max-w-2xl space-y-3">
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-base font-semibold">OpenAI subscription</h2>
          <Badge variant="secondary">Organization</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          Use the Codex allowance included with an eligible ChatGPT plan for GPT/Codex
          turns across this organization.
        </p>
      </div>

      {subscription ? (
        <div className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 text-sm">
            <p className="font-medium">
              {subscription.accountEmail ?? "OpenAI account connected"}
            </p>
            <p className="text-xs text-muted-foreground">
              {subscription.planType ? `${subscription.planType} plan · ` : ""}
              Shared by this camelAI organization
            </p>
          </div>
          <div className="flex gap-2">
            <OpenAiSignInFlow
              orgId={orgId}
              reconnect
              startLabel="Reconnect"
              onSuccess={() => revalidator.revalidate()}
            />
            <Button variant="destructive" size="sm" onClick={disconnect} disabled={isSubmitting}>
              {isSubmitting && isDeleting ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </div>
      ) : (
        <OpenAiSignInFlow
          orgId={orgId}
          onSuccess={() => revalidator.revalidate()}
        />
      )}
    </section>
  );
}
