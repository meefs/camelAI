import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanPicker } from "../src/components/billing/plan-picker";

describe("PlanPicker BYOK state", () => {
  it("shows Pay as you go as the individual no-subscription continue path", () => {
    render(
      <PlanPicker byokProviderLabel="OpenRouter" onSelectPlan={vi.fn()} />,
    );

    expect(screen.getByText("Pay as you go")).toBeInTheDocument();
    expect(
      screen.getByText("For a trial run, bring your own LLM provider"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });
});
