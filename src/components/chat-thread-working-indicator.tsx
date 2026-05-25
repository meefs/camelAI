import { useEffect, useState } from "react";
import { CamelLoader } from "@/components/camel-loader/camel-loader";
import { formatRunningElapsed } from "@/lib/chat-group-hover-time";

interface ChatThreadWorkingIndicatorProps {
  /** Unix ms timestamp the current agent turn started, or null if unknown. */
  startedAt: number | null;
}

export function ChatThreadWorkingIndicator({
  startedAt,
}: ChatThreadWorkingIndicatorProps) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === null) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [startedAt]);

  return (
    <div className="flex items-center gap-3 py-2 text-muted-foreground">
      <CamelLoader size={24} ariaLabel="Agent is working" />
      {startedAt !== null && (
        <span className="text-sm tabular-nums">
          {formatRunningElapsed(startedAt, now)}
        </span>
      )}
    </div>
  );
}
