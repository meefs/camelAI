import { ArrowRight, CircleAlert, Clock3, CreditCard, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import {
  type ChatApiErrorPresentation,
  isRateLimitChatApiErrorPresentation,
} from "@/lib/chat-api-errors";
import { cn } from "@/lib/utils";

export function ChatRateLimitNotice({
  presentation,
  onDismiss,
  className,
}: {
  presentation: Extract<
    ChatApiErrorPresentation,
    { kind: "byok_rate_limit" | "hosted_rate_limit" }
  >;
  onDismiss?: () => void;
  className?: string;
}) {
  const providerUrl =
    presentation.kind === "byok_rate_limit" ? presentation.providerUrl : null;
  const providerLinkLabel =
    presentation.kind === "byok_rate_limit"
      ? presentation.providerLinkLabel
      : null;

  return (
    <Alert className={cn("px-3 py-2 text-sm", className)}>
      <Clock3 className="h-4 w-4 text-muted-foreground" />
      <AlertTitle className="text-sm">{presentation.title}</AlertTitle>
      <AlertDescription className="space-y-1 text-sm text-muted-foreground">
        <p>{presentation.message}</p>
        {providerUrl ? (
          <a
            href={providerUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {providerLinkLabel ?? "Open provider settings"}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </AlertDescription>
      {onDismiss ? (
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}

export function ChatApiErrorNotice({
  presentation,
  onDismiss,
  className,
}: {
  presentation: ChatApiErrorPresentation;
  onDismiss?: () => void;
  className?: string;
}) {
  if (isRateLimitChatApiErrorPresentation(presentation)) {
    return (
      <ChatRateLimitNotice
        presentation={presentation}
        onDismiss={onDismiss}
        className={className}
      />
    );
  }

  if (presentation.kind === "billing_action") {
    return (
      <Alert className={cn("px-3 py-2 text-sm", className)}>
        <CreditCard className="h-4 w-4 text-muted-foreground" />
        <AlertTitle className="text-sm">{presentation.title}</AlertTitle>
        <AlertDescription className="space-y-2 text-sm text-muted-foreground">
          <p>{presentation.message}</p>
          <Button asChild size="sm" className="h-7">
            <a href={presentation.actionHref}>{presentation.actionLabel}</a>
          </Button>
        </AlertDescription>
        {onDismiss ? (
          <AlertAction>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5 text-muted-foreground hover:text-foreground"
              aria-label="Dismiss error"
              onClick={onDismiss}
            >
              <X className="h-3.5 w-3.5" />
            </Button>
          </AlertAction>
        ) : null}
      </Alert>
    );
  }

  return (
    <Alert className={cn("px-3 py-2 text-sm", className)}>
      <CircleAlert className="h-4 w-4 text-muted-foreground" />
      {presentation.title ? (
        <AlertTitle className="text-sm">{presentation.title}</AlertTitle>
      ) : null}
      <AlertDescription className="space-y-2 text-sm text-muted-foreground">
        <p>{presentation.message}</p>
        {presentation.actionHref ? (
          <a
            href={presentation.actionHref}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            {presentation.actionLabel ?? "Open documentation"}
            <ArrowRight className="size-3.5" aria-hidden="true" />
          </a>
        ) : null}
      </AlertDescription>
      {onDismiss ? (
        <AlertAction>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="h-5 w-5 text-muted-foreground hover:text-foreground"
            aria-label="Dismiss error"
            onClick={onDismiss}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </AlertAction>
      ) : null}
    </Alert>
  );
}
