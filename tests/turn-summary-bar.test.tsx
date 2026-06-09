import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnSummaryBar } from "@/components/turn-summary-bar";

describe("TurnSummaryBar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the formatted summary line with default final-answer chrome", () => {
    const { container } = render(
      <TurnSummaryBar durationMs={138_000} stepCount={14}>
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    expect(screen.getByText("worked for")).toBeInTheDocument();
    expect(screen.getByText("2:18")).toBeInTheDocument();
    expect(screen.getByText("14 steps")).toBeInTheDocument();
    expect(
      screen.getByRole("button", {
        name: "Show work, 14 steps, 2 minutes 18 seconds",
      }),
    ).toBeInTheDocument();
    expect(container.querySelector("hr")).toBeInTheDocument();
  });

  it("can render work-only chrome without duration or separator", () => {
    const { container } = render(
      <TurnSummaryBar
        durationMs={0}
        stepCount={3}
        showDuration={false}
        showSeparator={false}
      >
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    expect(screen.queryByText("worked for")).not.toBeInTheDocument();
    expect(screen.queryByText("0:00")).not.toBeInTheDocument();
    expect(screen.getByText("3 steps")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Show work, 3 steps" }),
    ).toBeInTheDocument();
    expect(container.querySelector("hr")).not.toBeInTheDocument();
  });

  it("click toggles expanded state and accessible label", async () => {
    const user = userEvent.setup();
    render(
      <TurnSummaryBar durationMs={1_000} stepCount={1}>
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    await user.click(screen.getByRole("button", { name: /show work/i }));
    expect(screen.getByRole("button", { name: /hide work/i })).toHaveTextContent(
      "hide work",
    );
    expect(screen.getByText("trace row")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /hide work/i }));
    expect(screen.getByRole("button", { name: /show work/i })).toHaveTextContent(
      "show work",
    );
  });

  it("latches auto-collapse at mount for live completions", () => {
    const frames: { callback: FrameRequestCallback; cancelled: boolean }[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push({ callback, cancelled: false });
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      const frame = frames[id - 1];
      if (frame) frame.cancelled = true;
    });
    const onAutoCollapseScheduled = vi.fn();

    const { rerender } = render(
      <TurnSummaryBar
        durationMs={1_000}
        stepCount={1}
        animateOnMount
        onAutoCollapseScheduled={onAutoCollapseScheduled}
      >
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    expect(screen.getByRole("button", { name: /hide work/i })).toBeInTheDocument();
    expect(screen.getByText("trace row")).toBeInTheDocument();

    rerender(
      <TurnSummaryBar
        durationMs={1_000}
        stepCount={1}
        animateOnMount={false}
        onAutoCollapseScheduled={onAutoCollapseScheduled}
      >
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    act(() => {
      frames
        .filter((frame) => !frame.cancelled)
        .forEach((frame) => frame.callback(0));
    });

    expect(onAutoCollapseScheduled).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: /show work/i })).toBeInTheDocument();
  });

  it("keeps reduced-motion classes on animated regions", () => {
    render(
      <TurnSummaryBar durationMs={1_000} stepCount={1} defaultExpanded>
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    expect(screen.getByText("trace row").closest("[data-slot='collapsible-content']")).toHaveClass(
      "motion-reduce:animate-none",
    );
  });

  it("aligns expanded trace rows without a turn-level left rule", () => {
    render(
      <TurnSummaryBar durationMs={1_000} stepCount={1} defaultExpanded>
        <div>trace row</div>
      </TurnSummaryBar>,
    );

    expect(screen.getByText("trace row").parentElement).toHaveClass(
      "space-y-1",
      "py-2",
    );
    expect(screen.getByText("trace row").parentElement).not.toHaveClass(
      "border-l",
      "pl-4",
      "ml-1",
    );
  });
});
