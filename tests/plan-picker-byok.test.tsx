import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanPicker } from "../src/components/billing/plan-picker";

describe("PlanPicker BYOK state", () => {
  it("shows only subscription plans in the individual grid", () => {
    render(
      <PlanPicker byokProviderLabel="OpenRouter" onSelectPlan={vi.fn()} />,
    );

    expect(screen.queryByText("Pay as you go")).not.toBeInTheDocument();
    expect(screen.getByText("Starter")).toBeInTheDocument();
    expect(screen.getByText("Pro")).toBeInTheDocument();
    expect(screen.getByText("Everything in Free, plus:")).toBeInTheDocument();
    expect(
      screen.getByText(
        "5× daily web search, research, and Oracle allowances",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getAllByText("Priority over free traffic on camelCode"),
    ).not.toHaveLength(0);
  });

  it("keeps the current-plan action disabled unless a caller opts in", () => {
    render(
      <PlanPicker
        currentPlan="pro"
        byokProviderLabel="OpenRouter"
        onSelectPlan={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "Current plan" })).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Manage in Stripe" })).not.toBeInTheDocument();
  });
});
