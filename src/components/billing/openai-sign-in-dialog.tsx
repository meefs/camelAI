import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useFetcher } from "react-router";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export interface OpenAiSubscriptionActionResponse {
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

type SignInIntent = "start" | "poll" | null;

export function OpenAiSignInFlow({
  orgId,
  onSuccess,
  startLabel = "Sign in with OpenAI",
  reconnect = false,
}: {
  orgId: string;
  onSuccess?: () => void;
  startLabel?: string;
  reconnect?: boolean;
}) {
  const fetcher = useFetcher<OpenAiSubscriptionActionResponse>();
  const [intent, setIntent] = useState<SignInIntent>(null);
  const [device, setDevice] = useState<DeviceState | null>(null);
  const [copied, setCopied] = useState(false);
  const action = `/api/orgs/${orgId}/llm-provider`;
  const isSubmitting = fetcher.state !== "idle";

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
      onSuccess?.();
    }
  }, [fetcher.data, fetcher.state, intent, onSuccess]);

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
        {
          intent: "pollOpenAiSubscription",
          pending_token: device.pendingToken,
        },
        { method: "POST", action, encType: "application/json" },
      );
    }, device.intervalSeconds * 1000);
    return () => window.clearTimeout(timeout);
  }, [action, device, fetcher, fetcher.state, intent]);

  useEffect(() => {
    if (!copied) return;
    const timeout = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timeout);
  }, [copied]);

  const start = () => {
    setDevice(null);
    setIntent("start");
    fetcher.submit(
      { intent: "startOpenAiSubscription" },
      { method: "POST", action, encType: "application/json" },
    );
  };

  if (device) {
    return (
      <Alert>
        <AlertTitle>Finish signing in with OpenAI</AlertTitle>
        <AlertDescription className="mt-2 space-y-3">
          <p>Open the device sign-in page and enter this one-time code:</p>
          <div className="flex items-center gap-2">
            <span className="font-mono text-xl font-semibold tracking-widest text-foreground">
              {device.userCode}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={async () => {
                await navigator.clipboard.writeText(device.userCode);
                setCopied(true);
              }}
              aria-label={copied ? "Copied" : "Copy code"}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </div>
          <Button
            type="button"
            onClick={() =>
              window.open(
                device.verificationUrl,
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            Open OpenAI sign-in
            <ExternalLink />
          </Button>
          <p className="text-xs">Waiting for authorization…</p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Button
      type="button"
      variant="outline"
      size={reconnect ? "sm" : "default"}
      onClick={start}
      disabled={isSubmitting}
    >
      {isSubmitting && intent === "start" ? "Starting sign-in…" : startLabel}
    </Button>
  );
}

export function OpenAiSignInDialog({
  open,
  onOpenChange,
  orgId,
  onSuccess,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  orgId: string;
  onSuccess?: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Sign in with OpenAI</DialogTitle>
          <DialogDescription>
            Use the GPT model allowance included with an eligible ChatGPT plan.
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <OpenAiSignInFlow
            orgId={orgId}
            onSuccess={() => {
              onOpenChange(false);
              onSuccess?.();
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
