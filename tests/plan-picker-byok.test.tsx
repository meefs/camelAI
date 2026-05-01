import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PlanPicker } from "../src/components/billing/plan-picker";

describe("PlanPicker BYOK state", () => {
  it("shows the connected provider as the free-plan continue path", () => {
    render(
      <PlanPicker byokProviderLabel="OpenRouter" onSelectPlan={vi.fn()} />,
    );

    expect(
      screen.getByRole("button", { name: "Continue with OpenRouter" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("OpenRouter API key connected"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Stay on Free using your own key, or start a paid plan to use hosted credits through camelAI.",
      ),
    ).toBeInTheDocument();
  });
});
