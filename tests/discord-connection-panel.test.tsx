import {
  act,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  createMemoryRouter,
  RouterProvider,
  type ActionFunctionArgs,
} from "react-router";
import { ConnectionPanel } from "@/components/pages/connections/connection-panel";
import type {
  ConnectionListItem,
  PanelItem,
} from "@/lib/connections-shared";
import { TooltipProvider } from "@/components/ui/tooltip";

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

beforeAll(() => {
  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  });
});

function discordConnection(
  config: Record<string, unknown>,
): ConnectionListItem {
  return {
    id: "discord_1",
    integration_type: "discord_channel",
    name: "Camel HQ #general",
    category: "communication",
    auth_method: "oauth2",
    config,
    created_by: "user_1",
    created_at: 1,
    updated_at: 1,
    has_credentials: true,
  };
}

function setupData() {
  return {
    discordSetup: {
      integrationId: "discord_1",
      guild: { id: "guild_1", name: "Camel HQ" },
      channels: [
        {
          id: "hidden",
          name: "private",
          categoryId: null,
          categoryName: null,
          missingPermissions: [
            "VIEW_CHANNEL",
            "SEND_MESSAGES",
            "EMBED_LINKS",
            "ATTACH_FILES",
            "READ_MESSAGE_HISTORY",
            "CREATE_PUBLIC_THREADS",
            "SEND_MESSAGES_IN_THREADS",
          ],
          canActivate: false,
          exposure: "restricted" as const,
        },
        {
          id: "missing",
          name: "support",
          categoryId: "category_1",
          categoryName: "Team",
          missingPermissions: ["SEND_MESSAGES", "ATTACH_FILES"],
          canActivate: false,
          exposure: "restricted" as const,
        },
        {
          id: "general",
          name: "general",
          categoryId: "category_1",
          categoryName: "Team",
          missingPermissions: [],
          canActivate: true,
          exposure: "visible_to_everyone" as const,
        },
      ],
    },
  };
}

const actionHandlers = {
  onStartRename: vi.fn(),
  onConfigure: vi.fn(),
  onReconnect: vi.fn(),
  onVerify: vi.fn(),
  onClone: vi.fn(),
  onDelete: vi.fn(),
  onCopyEmailAddress: vi.fn(),
  onManageEmailSettings: vi.fn(),
};

function renderPanel({
  item,
  action,
  isAdmin = true,
  mentionSlug = null,
}: {
  item: PanelItem;
  action: (args: ActionFunctionArgs) => unknown;
  isAdmin?: boolean;
  mentionSlug?: string | null;
}) {
  const router = createMemoryRouter(
    [
      {
        path: "/connections",
        action,
        element: (
          <TooltipProvider>
            <ConnectionPanel
              item={item}
              isAdmin={isAdmin}
              otherWorkspacesCount={0}
              mentionSlug={mentionSlug}
              renaming={null}
              renameSubmitting={false}
              onRenameValueChange={vi.fn()}
              onCommitRename={vi.fn()}
              onCancelRename={vi.fn()}
              onClose={vi.fn()}
              onNewChat={vi.fn()}
              {...actionHandlers}
            />
          </TooltipProvider>
        ),
      },
    ],
    { initialEntries: ["/connections"] },
  );

  return render(<RouterProvider router={router} />);
}

function renderDiscordPanel({
  connection,
  action,
  isAdmin = true,
  mentionSlug = null,
}: {
  connection: ConnectionListItem;
  action: (args: ActionFunctionArgs) => unknown;
  isAdmin?: boolean;
  mentionSlug?: string | null;
}) {
  return renderPanel({
    item: {
      kind: "channel",
      channel: "discord_channel",
      id: connection.id,
      connection,
    },
    action,
    isAdmin,
    mentionSlug,
  });
}

describe("DiscordDestination setup state", () => {
  it("auto-loads once and explains blocked channels in the inline picker", async () => {
    const user = userEvent.setup();
    let resolveInitialLoad:
      | ((value: ReturnType<typeof setupData>) => void)
      | undefined;
    const initialLoad = new Promise<ReturnType<typeof setupData>>((resolve) => {
      resolveInitialLoad = resolve;
    });
    let listCallCount = 0;
    const action = vi.fn(async ({ request }: ActionFunctionArgs) => {
      const formData = await request.formData();
      const intent = formData.get("intent");
      if (intent === "discordListChannels") {
        listCallCount += 1;
        return listCallCount === 1 ? initialLoad : setupData();
      }
      return { success: true };
    });
    const { container } = renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        status: "pending_channel",
        message_content_mode: "all_messages",
      }),
      action,
    });

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(container.querySelectorAll("[data-slot='skeleton']")).toHaveLength(4);

    await act(async () => {
      resolveInitialLoad?.(setupData());
      await initialLoad;
    });

    expect(await screen.findByText("Camel can't see this channel")).toBeInTheDocument();
    expect(
      screen.getByText("Camel is missing: Send Messages, Attach Files"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Grayed-out channels need access granted in Discord/),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Camel can't see this channel").closest("[data-slot='command-item']"),
    ).toHaveAttribute("data-disabled", "true");
    expect(
      screen.getByText("Camel can't see this channel").closest("[data-slot='command-item']"),
    ).toHaveClass("data-[disabled=true]:opacity-100");
    expect(screen.queryByText("Use in Discord")).not.toBeInTheDocument();

    const connectButton = screen.getByRole("button", {
      name: "Connect channel",
    });
    expect(connectButton).toBeDisabled();
    await user.click(screen.getByText("general"));
    expect(connectButton).toBeDisabled();
    await user.click(screen.getByRole("checkbox"));
    expect(connectButton).toBeEnabled();

    await user.click(
      screen.getByRole("button", { name: "Reload channel list" }),
    );
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
  });

  it("renders a retry action when loading channels fails", async () => {
    const user = userEvent.setup();
    let calls = 0;
    const action = vi.fn(async ({ request }: ActionFunctionArgs) => {
      const formData = await request.formData();
      if (formData.get("intent") === "discordListChannels") {
        calls += 1;
        return calls === 1
          ? { error: "Discord channel lookup failed" }
          : setupData();
      }
      return { success: true };
    });
    renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        status: "pending_channel",
      }),
      action,
    });

    expect(
      await screen.findByText("Discord channel lookup failed"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("general")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("shows the guild removal lifecycle banner and reinstall link", async () => {
    const action = vi.fn(async () => setupData());
    renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        status: "disconnected",
        error_code: "guild_removed",
      }),
      action,
    });

    expect(
      screen.getByText("Camel was removed from this server"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Camel is no longer in this server. Reinstall the bot to reconnect.",
      ),
    ).toBeInTheDocument();
    const reinstall = screen.getByRole("link", {
      name: "Reinstall Camel bot",
    });
    expect(reinstall).toHaveAttribute(
      "href",
      "/api/integrations/discord/oauth?integration_id=discord_1&redirect=%2Fconnections",
    );
  });

  it("keeps duplicate channel names independently selectable", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async () => ({
      discordSetup: {
        integrationId: "discord_1",
        guild: { id: "guild_1", name: "Camel HQ" },
        channels: [
          {
            id: "general_one",
            name: "general",
            categoryId: "category_1",
            categoryName: "Team One",
            missingPermissions: [],
            canActivate: true,
            exposure: "restricted" as const,
          },
          {
            id: "general_two",
            name: "general",
            categoryId: "category_2",
            categoryName: "Team Two",
            missingPermissions: [],
            canActivate: true,
            exposure: "restricted" as const,
          },
        ],
      },
    }));
    const { container } = renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        status: "pending_channel",
      }),
      action,
    });

    const names = await screen.findAllByText("general");
    expect(names).toHaveLength(2);
    await user.click(names[1]!);

    const firstItem = names[0]!.closest("[data-slot='command-item']");
    const secondItem = names[1]!.closest("[data-slot='command-item']");
    expect(firstItem?.querySelector("[data-checked='true']")).toBeNull();
    expect(secondItem?.querySelector("[data-checked='true']")).not.toBeNull();
    expect(
      container.querySelector<HTMLInputElement>(
        "input[name='parentChannelId']",
      ),
    ).toHaveValue("general_two");
  });
});

describe("DiscordDestination active state", () => {
  it("opens channel selection for a staged reauthorization while keeping the active destination", async () => {
    const action = vi.fn(async () => setupData());
    renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        parent_channel_name: "general",
        parent_channel_id: "general",
        status: "active",
        message_content_mode: "full",
        security_acknowledged_at: 1,
        pending_reauthorization: {
          activation_attempt_id: "reauthorization-attempt",
          application_id: "app_1",
          guild_id: "guild_1",
          guild_name: "Camel HQ",
          message_content_mode: "full",
        },
      }),
      action,
    });

    expect(await screen.findByText("Camel can't see this channel")).toBeInTheDocument();
    expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Change channel" })).toBeEnabled();
    expect(screen.getByText("#general")).toBeInTheDocument();
  });

  it("separates Discord usage from the camelAI-chat mention and copies @Camel", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        parent_channel_name: "general",
        parent_channel_id: "general",
        status: "active",
        message_content_mode: "all_messages",
        security_acknowledged_at: 1,
      }),
      action: vi.fn(async () => ({ success: true })),
      mentionSlug: "camel-hq-general",
    });

    const discordUsage = screen.getByText("Use in Discord").closest("section");
    expect(discordUsage).not.toBeNull();
    expect(within(discordUsage!).getByText("@Camel")).toBeInTheDocument();
    expect(
      within(discordUsage!).getByText(
        "Mention @Camel in #general to start a thread. Camel replies in a thread and follows it, no mention needed on follow-ups.",
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("Use in camelAI chat")).toBeInTheDocument();
    expect(screen.queryByText("Use in chat")).not.toBeInTheDocument();
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual([
      "Destination & identity",
      "Use in Discord",
      "Use in camelAI chat",
      "Status & housekeeping",
    ]);

    await user.click(
      within(discordUsage!).getByRole("button", {
        name: "Copy Discord mention",
      }),
    );
    expect(writeText).toHaveBeenCalledWith("@Camel");
  });

  it("uses the compact security note and confirms before disconnecting", async () => {
    const user = userEvent.setup();
    let submittedIntent: FormDataEntryValue | null = null;
    const action = vi.fn(async ({ request }: ActionFunctionArgs) => {
      const formData = await request.formData();
      submittedIntent = formData.get("intent");
      return { success: true };
    });
    renderDiscordPanel({
      connection: discordConnection({
        guild_name: "Camel HQ",
        parent_channel_name: "general",
        parent_channel_id: "general",
        status: "active",
        message_content_mode: "mention_only",
        security_acknowledged_at: 1,
      }),
      action,
    });

    expect(
      screen.queryByText("Discord members can instruct this workspace"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByText(
        "Anyone who can post in #general can instruct Camel with this workspace's authority.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Messages from this Discord channel start threads here."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Mention @Camel in #general to start a thread. Mention-only mode is on, so every follow-up must also mention @Camel.",
      ),
    ).toBeInTheDocument();

    const reinstall = screen.getByRole("link", { name: "Reinstall bot" });
    await user.hover(reinstall);
    expect(
      await screen.findAllByText(/You'll pick the channel again afterward/),
    ).not.toHaveLength(0);

    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(action).not.toHaveBeenCalled();
    const dialog = screen.getByRole("alertdialog");
    expect(
      within(dialog).getByText("Disconnect Discord channel?"),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Disconnect" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(submittedIntent).toBe("discordDisconnect");
  });
});

describe("connection mention section title", () => {
  it("titles the native Email channel mention for camelAI chat", () => {
    renderPanel({
      item: {
        kind: "channel",
        channel: "email",
        id: "email",
        email: {
          address: "workspace@example.com",
          handle: "workspace",
          mentionSlug: "workspace-email",
          inboxEnabled: true,
          workspaceCreatedBy: "user_1",
          workspaceCreatedAt: 1,
        },
      },
      action: vi.fn(async () => ({ success: true })),
      mentionSlug: "workspace-email",
    });

    expect(screen.getByText("Use in camelAI chat")).toBeInTheDocument();
    expect(screen.queryByText("Use in chat")).not.toBeInTheDocument();
  });

  it("keeps regular connections titled Use in chat", () => {
    const connection: ConnectionListItem = {
      id: "postgres_1",
      integration_type: "postgres",
      name: "Production database",
      category: "databases",
      auth_method: "api_key",
      config: {},
      created_by: "user_1",
      created_at: 1,
      updated_at: 1,
      has_credentials: true,
    };

    renderPanel({
      item: {
        kind: "connection",
        id: connection.id,
        connection,
      },
      action: vi.fn(async () => ({ success: true })),
      mentionSlug: "production-database",
    });

    expect(screen.getByText("Use in chat")).toBeInTheDocument();
    expect(screen.queryByText("Use in camelAI chat")).not.toBeInTheDocument();
  });
});
