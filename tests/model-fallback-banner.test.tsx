import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelFallbackBanner } from "@/components/model-fallback-banner";
import type { ChatAgentModelFallbackNotice } from "@/lib/chat-agent-state";

function renderBanner(
  fromModel: string,
  reason: ChatAgentModelFallbackNotice["reason"] = "hosted_credits_exhausted",
) {
  const notice: ChatAgentModelFallbackNotice = {
    id: `fallback-${fromModel}-${reason}`,
    fromModel,
    toModel: "deepseek-v4-auto",
    reason,
    createdAt: Date.now(),
  };

  return render(
    <MemoryRouter>
      <ModelFallbackBanner
        notice={notice}
        activeModel="deepseek-v4-auto"
        isOrgAdmin
        onTopUp={vi.fn()}
        onUpgrade={vi.fn()}
        onAddKey={vi.fn()}
        onOpenAiSignIn={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe("ModelFallbackBanner OpenAI guidance", () => {
  beforeEach(() => window.localStorage.clear());

  it("names camelCode in both fallback variants", () => {
    const { unmount } = renderBanner("gpt-5.6-sol");
    expect(
      screen.getByText("Monthly credits used up — switched to camelCode."),
    ).toBeInTheDocument();

    unmount();
    renderBanner("gpt-5.6-sol", "hosted_subscription_unavailable");
    expect(
      screen.getByText(
        "Your subscription is unavailable — switched to camelCode.",
      ),
    ).toBeInTheDocument();
  });

  it("offers OpenAI sign-in for subscription-covered GPT models", () => {
    renderBanner("gpt-5.6-sol");

    expect(
      screen.getByRole("button", { name: "Sign in with OpenAI" }),
    ).toBeInTheDocument();
  });

  it("does not offer OpenAI sign-in for other Codex-harness models", () => {
    renderBanner("grok-4.5");

    expect(
      screen.queryByRole("button", { name: "Sign in with OpenAI" }),
    ).not.toBeInTheDocument();
  });
});
