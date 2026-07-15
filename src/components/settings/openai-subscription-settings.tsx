import { useEffect, useState } from "react";
import { ExternalLink } from "lucide-react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export interface OpenAiSubscriptionPublic {
  accountEmail: string | null;
  planType: string | null;
  updatedAt: number;
}

interface ActionResponse {
  success?: boolean;
  error?: string;
  status?: "pending" | "complete";
  pending_token?: string;
  user_code?: string;
  verification_url?: string;
  interval_seconds?: number;
  expires_at?: number;
  account_email?: string | null;
}

interface DeviceState {
  pendingToken: string;
  userCode: string;
  verificationUrl: string;
  intervalSeconds: number;
  expiresAt: number;
}

type Intent = "start" | "poll" | "delete" | null;

export function OpenAiSubscriptionSettings({
  orgId,
  subscription,
}: {
  orgId: string;
  subscription: OpenAiSubscriptionPublic | null;
}) {
  const fetcher = useFetcher<ActionResponse>();
  const [intent, setIntent] = useState<Intent>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const isSubmitting = fetcher.state !== "idle";
  const action = `/api/orgs/${orgId}/llm-provider`;

  useEffect(() => {
    if (fetcher.state !== "idle" || !fetcher.data || !intent) return;
    if (fetcher.data.error) {
      setDevice(null);
      setIntent(null);
      toast.error(fetcher.data.error);
      return;
    }
    if (
      intent === "start" &&
      fetcher.data.status === "pending" &&
      fetcher.data.pending_token &&
      fetcher.data.user_code &&
      fetcher.data.verification_url
    ) {
      setDevice({
        pendingToken: fetcher.data.pending_token,
        userCode: fetcher.data.user_code,
        verificationUrl: fetcher.data.verification_url,
        intervalSeconds: Math.max(1, fetcher.data.interval_seconds ?? 5),
        expiresAt: fetcher.data.expires_at ?? Date.now() + 15 * 60 * 1000,
      });
      setIntent("poll");
      return;
    }
    if (intent === "poll" && fetcher.data.status === "complete") {
      setDevice(null);
      setIntent(null);
      toast.success(
        fetcher.data.account_email
          ? `Connected ${fetcher.data.account_email}.`
          : "OpenAI subscription connected.",
      );
      return;
    }
    if (intent === "delete" && fetcher.data.success) {
      setIntent(null);
      toast.success("OpenAI subscription disconnected.");
    }
  }, [fetcher.data, fetcher.state, intent]);

  useEffect(() => {
    if (!device || intent !== "poll" || fetcher.state !== "idle") return;
    if (device.expiresAt <= Date.now()) {
      setDevice(null);
      setIntent(null);
      toast.error("OpenAI sign-in code expired. Start again.");
      return;
    }
    const timeout = window.setTimeout(() => {
      fetcher.submit(
        { intent: "pollOpenAiSubscription", pending_token: device.pendingToken },
        { method: "POST", action, encType: "application/json" },
      );
    }, device.intervalSeconds * 1000);
    return () => window.clearTimeout(timeout);
  }, [action, device, fetcher, fetcher.state, intent]);

  const start = () => {
    setDevice(null);
    setIntent("start");
    fetcher.submit(
      { intent: "startOpenAiSubscription" },
      { method: "POST", action, encType: "application/json" },
    );
  };

  const disconnect = () => {
    setDevice(null);
    setIntent("delete");
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

      {device ? (
        <Alert>
          <AlertTitle>Finish signing in with OpenAI</AlertTitle>
          <AlertDescription className="mt-2 space-y-3">
            <p>Open the device sign-in page and enter this one-time code:</p>
            <p className="font-mono text-xl font-semibold tracking-widest text-foreground">
              {device.userCode}
            </p>
            <Button
              onClick={() =>
                window.open(device.verificationUrl, "_blank", "noopener,noreferrer")
              }
            >
              Sign into OpenAI
              <ExternalLink />
            </Button>
            <p className="text-xs">Waiting for authorization…</p>
          </AlertDescription>
        </Alert>
      ) : subscription ? (
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
            <Button variant="outline" size="sm" onClick={start} disabled={isSubmitting}>
              Reconnect
            </Button>
            <Button variant="destructive" size="sm" onClick={disconnect} disabled={isSubmitting}>
              {isSubmitting && intent === "delete" ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
        </div>
      ) : (
        <Button variant="outline" onClick={start} disabled={isSubmitting}>
          {isSubmitting && intent === "start" ? "Starting sign-in…" : "Sign in with OpenAI"}
        </Button>
      )}
    </section>
  );
}
