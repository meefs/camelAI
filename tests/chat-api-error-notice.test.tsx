import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatApiErrorNotice } from "@/components/chat-api-error-notice";

describe("ChatApiErrorNotice", () => {
  it("renders an internal reconnect action for an expired OpenAI connection", () => {
    render(
      <ChatApiErrorNotice
        presentation={{
          kind: "provider_auth_action",
          title: "Reconnect your OpenAI account",
          message:
            "OpenAI rejected the saved ChatGPT/Codex login. Reconnect it in AI Provider settings.",
          actionHref:
            "/settings/organization/ai-provider#openai-subscription",
          actionLabel: "Reconnect OpenAI",
        }}
      />,
    );

    expect(
      screen.getByRole("link", { name: "Reconnect OpenAI" }),
    ).toHaveAttribute(
      "href",
      "/settings/organization/ai-provider#openai-subscription",
    );
  });
});
