import { Component, type ErrorInfo, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { reportClientError } from "@/lib/client-error-reporting";

interface ChatTranscriptErrorBoundaryProps {
  children: ReactNode;
}

interface ChatTranscriptErrorBoundaryState {
  hasRenderError: boolean;
}

/**
 * Catches render/commit exceptions from the chat transcript so they degrade
 * to an inline retry notice instead of escalating to the root error boundary
 * (which replaces the whole app shell with a full-page error).
 *
 * The main known trigger is third-party DOM mutation — Chrome/Google Translate
 * wraps React-owned text nodes in `<font>` elements, and a later React commit
 * that deletes those nodes throws `NotFoundError: removeChild`. Retrying
 * remounts the transcript subtree with fresh React-owned DOM.
 */
export class ChatTranscriptErrorBoundary extends Component<
  ChatTranscriptErrorBoundaryProps,
  ChatTranscriptErrorBoundaryState
> {
  state: ChatTranscriptErrorBoundaryState = { hasRenderError: false };

  static getDerivedStateFromError(): ChatTranscriptErrorBoundaryState {
    return { hasRenderError: true };
  }

  componentDidCatch(error: unknown, errorInfo: ErrorInfo) {
    reportClientError({
      source: "react_error_boundary",
      error,
      componentStack: errorInfo.componentStack ?? undefined,
      routeId: "chat-transcript",
    });
  }

  handleRetry = () => {
    this.setState({ hasRenderError: false });
  };

  render() {
    if (this.state.hasRenderError) {
      return (
        <div className="mt-8 flex flex-col items-center gap-3 rounded-lg border border-border bg-muted/40 px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            The chat transcript failed to render. This can be caused by browser
            translation or extensions modifying the page.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-2">
            <Button type="button" size="sm" onClick={this.handleRetry}>
              <RefreshCw aria-hidden="true" />
              Retry
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => window.location.reload()}
            >
              Reload page
            </Button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
