import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatThreadWorkingIndicator } from "@/components/chat-thread-working-indicator";

describe("ChatThreadWorkingIndicator", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not read Date.now during server render", () => {
    vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now should only be read after hydration");
    });

    expect(() =>
      renderToString(<ChatThreadWorkingIndicator startedAt={1_000_000} />),
    ).not.toThrow();
  });

  it("renders deterministic initial elapsed text", () => {
    const markup = renderToString(
      <ChatThreadWorkingIndicator startedAt={1_000_000} />,
    );

    expect(markup).toContain(">0s</span>");
  });
});
