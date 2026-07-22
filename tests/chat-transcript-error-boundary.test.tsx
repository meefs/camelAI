import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatTranscriptErrorBoundary } from "@/components/chat-transcript-error-boundary";
import { reportClientError } from "@/lib/client-error-reporting";

vi.mock("@/lib/client-error-reporting", () => ({
  reportClientError: vi.fn(),
}));

let shouldThrow = true;

function FlakyTranscript() {
  if (shouldThrow) {
    throw new DOMException(
      "Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node.",
      "NotFoundError",
    );
  }
  return <div>transcript content</div>;
}

describe("ChatTranscriptErrorBoundary", () => {
  afterEach(() => {
    shouldThrow = true;
    vi.clearAllMocks();
  });

  it("renders children when nothing throws", () => {
    shouldThrow = false;
    render(
      <ChatTranscriptErrorBoundary>
        <FlakyTranscript />
      </ChatTranscriptErrorBoundary>,
    );
    expect(screen.getByText("transcript content")).toBeInTheDocument();
  });

  it("catches transcript render errors, reports them, and recovers via Retry", async () => {
    const user = userEvent.setup();
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    render(
      <ChatTranscriptErrorBoundary>
        <FlakyTranscript />
      </ChatTranscriptErrorBoundary>,
    );

    expect(
      screen.getByText(/chat transcript failed to render/i),
    ).toBeInTheDocument();
    expect(reportClientError).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "react_error_boundary",
        routeId: "chat-transcript",
      }),
    );

    shouldThrow = false;
    await user.click(screen.getByRole("button", { name: /retry/i }));

    expect(screen.getByText("transcript content")).toBeInTheDocument();
    consoleError.mockRestore();
  });
});
