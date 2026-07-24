import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionSetupPrompt } from "@/components/connection-setup-prompt";

describe("ConnectionSetupPrompt", () => {
  it("requires delegated-workspace acknowledgement before Discord authorization", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    const { rerender } = render(
      <ConnectionSetupPrompt
        data={{
          requestId: "setup-discord",
          integrationType: "discord_channel",
          suggestedName: "Support Discord",
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByText(/channel participants can instruct Camel/i)).toBeInTheDocument();
    expect(screen.getByText(/workspace's files, connected services, credits, and deploy/i))
      .toBeInTheDocument();
    const connect = screen.getByRole("button", { name: /connect discord/i });
    expect(connect).toBeDisabled();

    await user.click(screen.getByRole("checkbox"));
    expect(connect).toBeEnabled();

    rerender(
      <ConnectionSetupPrompt
        data={{
          requestId: "setup-discord-next",
          integrationType: "discord_channel",
          suggestedName: "Support Discord",
        }}
        onSubmit={onSubmit}
        onCancel={onCancel}
      />,
    );
    expect(screen.getByRole("button", { name: /connect discord/i })).toBeDisabled();
  });

  it("uses a textarea for BigQuery service account JSON and submits the entered connection", async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);

    render(
      <ConnectionSetupPrompt
        data={{
          requestId: "setup-bq",
          integrationType: "bigquery",
          suggestedName: "Analytics BQ",
        }}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
      />,
    );

    await user.type(screen.getByLabelText(/Project ID/i), "analytics-prod");
    const serviceAccountInput = screen.getByLabelText(/Service Account JSON/i);
    expect(serviceAccountInput.tagName).toBe("TEXTAREA");

    const serviceAccountJson = JSON.stringify({
      type: "service_account",
      project_id: "analytics-prod",
      client_email: "svc@example.iam.gserviceaccount.com",
      private_key: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n",
    });
    fireEvent.change(serviceAccountInput, { target: { value: serviceAccountJson } });
    await user.click(screen.getByRole("button", { name: /create connection/i }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    expect(onSubmit).toHaveBeenCalledWith({
      requestId: "setup-bq",
      cancelled: false,
      integration: {
        type: "bigquery",
        name: "Analytics BQ",
        config: { project_id: "analytics-prod" },
        credentials: { service_account_json: serviceAccountJson },
      },
    });
  });

  it("starts the managed GA4 OAuth flow with chat completion context", async () => {
    const user = userEvent.setup();
    const originalLocation = window.location;
    const location = {
      ...originalLocation,
      href: "http://localhost/chat/thread-123",
      pathname: "/chat/thread-123",
    };
    Object.defineProperty(window, "location", {
      configurable: true,
      value: location,
    });

    try {
      render(
        <ConnectionSetupPrompt
          data={{
            requestId: "setup-ga4",
            integrationType: "google_analytics",
            suggestedName: "Google Analytics 4",
          }}
          onSubmit={vi.fn()}
          onCancel={vi.fn()}
        />,
      );

      expect(
        screen.queryByText(/OAuth for Google Analytics 4 is not yet implemented/i),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: /connect Google Analytics 4/i }),
      );

      const oauthUrl = new URL(location.href, "http://localhost");
      expect(oauthUrl.pathname).toBe("/api/integrations/google_analytics/oauth");
      expect(oauthUrl.searchParams.get("redirect")).toBe("/chat/thread-123");
      expect(oauthUrl.searchParams.get("chat_request_id")).toBe("setup-ga4");
      expect(oauthUrl.searchParams.get("chat_thread_id")).toBe("thread-123");
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });
});
