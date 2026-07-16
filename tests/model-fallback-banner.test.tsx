import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelFallbackBanner } from "@/components/model-fallback-banner";
import type { ChatAgentModelFallbackNotice } from "@/lib/chat-agent-state";

function renderBanner(fromModel: string) {
  const notice: ChatAgentModelFallbackNotice = {
    id: `fallback-${fromModel}`,
    fromModel,
    toModel: "deepseek-v4-auto",
    reason: "hosted_credits_exhausted",
    createdAt: Date.now(),
  };

  render(
    <ModelFallbackBanner
      notice={notice}
      activeModel="deepseek-v4-auto"
      isOrgAdmin
      onTopUp={vi.fn()}
      onUpgrade={vi.fn()}
      onAddKey={vi.fn()}
      onOpenAiSignIn={vi.fn()}
    />,
  );
}

describe("ModelFallbackBanner OpenAI guidance", () => {
  beforeEach(() => window.localStorage.clear());

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
