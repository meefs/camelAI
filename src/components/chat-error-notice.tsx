import { ChatApiErrorNotice } from "@/components/chat-api-error-notice";
import type { ChatApiErrorPresentation } from "@/lib/chat-api-errors";

export function ChatErrorNotice({
  error,
  onDismiss,
  className,
}: {
  error: ChatApiErrorPresentation;
  onDismiss?: () => void;
  className?: string;
}) {
  return (
    <ChatApiErrorNotice
      presentation={error}
      onDismiss={onDismiss}
      className={className}
    />
  );
}
