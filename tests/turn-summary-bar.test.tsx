import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnSummaryBar } from "@/components/turn-summary-bar";

describe("TurnSummaryBar", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the formatted summary line", () => {
    render(
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

  it("mounts expanded then schedules auto-collapse for live completions", () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const onAutoCollapseScheduled = vi.fn();

    render(
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

    act(() => {
      frames.forEach((frame) => frame(0));
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
