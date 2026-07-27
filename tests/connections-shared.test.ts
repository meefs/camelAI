import { describe, expect, it } from "vitest";
import {
  buildConnectionGroups,
  deriveCapabilities,
  filterAndSortConnectionGroups,
  formatDiscordPermissionList,
  getChannelAttentionBadge,
  getDiscordChannelBlockReason,
  getDiscordChannelMetadata,
  type ConnectionListItem,
  type EmailChannel,
} from "@/lib/connections-shared";

function connection(
  fields: Partial<ConnectionListItem> & {
    id: string;
    integration_type: string;
    name: string;
  },
): ConnectionListItem {
  return {
    category: "saas",
    auth_method: "api_key",
    config: {},
    created_by: "user-1",
    created_at: 100,
    updated_at: 100,
    has_credentials: true,
    ...fields,
  };
}

const email: EmailChannel = {
  address: "workspace@example.com",
  handle: "workspace",
  inboxEnabled: true,
  workspaceCreatedBy: "user-1",
  workspaceCreatedByName: "User One",
  workspaceCreatedByAvatar: null,
  workspaceCreatedAt: 50,
};

describe("buildConnectionGroups", () => {
  it("keeps native email as a channel when there are no integrations", () => {
    const groups = buildConnectionGroups([], email);

    expect(groups.channels.map((item) => item.id)).toEqual(["email"]);
    expect(groups.connections).toEqual([]);
  });

  it("pins native email and classifies native messaging integration records as channels", () => {
    const groups = buildConnectionGroups(
      [
        connection({
          id: "slack",
          integration_type: "slack",
          name: "Slack workspace",
          category: "communication",
        }),
        connection({
          id: "telegram",
          integration_type: "telegram",
          name: "Telegram group",
          category: "communication",
        }),
        connection({
          id: "discord",
          integration_type: "discord_channel",
          name: "Discord channel",
          category: "communication",
        }),
        connection({
          id: "legacy-discord",
          integration_type: "discord",
          name: "Legacy Discord token",
          category: "communication",
        }),
        connection({
          id: "gmail",
          integration_type: "gmail",
          name: "Bella's Gmail App",
          category: "communication",
        }),
        connection({
          id: "sendgrid",
          integration_type: "sendgrid",
          name: "SendGrid",
          category: "communication",
        }),
        connection({
          id: "postgres",
          integration_type: "postgres",
          name: "Postgres",
          category: "databases",
        }),
      ],
      email,
    );

    expect(groups.channels.map((item) => item.id)).toEqual([
      "email",
      "slack",
      "telegram",
      "discord",
    ]);
    expect(groups.connections.map((item) => item.id)).toEqual([
      "legacy-discord",
      "gmail",
      "sendgrid",
      "postgres",
    ]);
  });
});

describe("filterAndSortConnectionGroups", () => {
  it("keeps email first while sorting the remaining channel items", () => {
    const groups = buildConnectionGroups(
      [
        connection({
          id: "telegram",
          integration_type: "telegram",
          name: "Zulu Telegram",
          category: "communication",
          created_at: 300,
          updated_at: 300,
        }),
        connection({
          id: "slack",
          integration_type: "slack",
          name: "Alpha Slack",
          category: "communication",
          created_at: 200,
          updated_at: 200,
        }),
      ],
      email,
    );

    const sorted = filterAndSortConnectionGroups(groups, "", "name");
    expect(sorted.channels.map((item) => item.id)).toEqual([
      "email",
      "slack",
      "telegram",
    ]);
  });

  it("filters email by address and connections by provider display name", () => {
    const groups = buildConnectionGroups(
      [
        connection({
          id: "db",
          integration_type: "postgres",
          name: "Prod",
          category: "databases",
        }),
      ],
      email,
    );

    expect(filterAndSortConnectionGroups(groups, "example.com", "updated").channels)
      .toHaveLength(1);
    expect(filterAndSortConnectionGroups(groups, "postgresql", "updated").connections)
      .toHaveLength(1);
  });
});

describe("deriveCapabilities", () => {
  it("marks database integrations as queryable and MCP-backed when registered", () => {
    expect(
      deriveCapabilities(
        connection({
          id: "postgres",
          integration_type: "postgres",
          name: "Postgres",
          category: "databases",
        }),
      ),
    ).toEqual(["query_database", "mcp_tools"]);
  });

  it("uses provider MCP metadata instead of falling back to generic authenticated fetch", () => {
    expect(
      deriveCapabilities(
        connection({
          id: "github",
          integration_type: "github",
          name: "GitHub",
        }),
      ),
    ).toEqual(["mcp_tools"]);
  });

  it("keeps generic API integrations and native channel sends distinct", () => {
    expect(
      deriveCapabilities(
        connection({
          id: "other",
          integration_type: "other",
          name: "Custom API",
          config: { base_url: "https://api.example.com" },
        }),
      ),
    ).toEqual(["authenticated_fetch"]);

    expect(
      deriveCapabilities(
        connection({
          id: "telegram",
          integration_type: "telegram",
          name: "Telegram",
          category: "communication",
        }),
      ),
    ).toEqual(["channel_send"]);

    expect(
      deriveCapabilities(
        connection({
          id: "discord",
          integration_type: "discord_channel",
          name: "Discord",
          category: "communication",
        }),
      ),
    ).toEqual(["channel_send"]);
  });

  it("reports credential-only connections honestly", () => {
    expect(
      deriveCapabilities(
        connection({
          id: "openai",
          integration_type: "openai",
          name: "OpenAI",
        }),
      ),
    ).toEqual(["project_credentials"]);
  });
});

describe("Discord channel presentation helpers", () => {
  it("formats Discord permission names and preserves unknown permissions", () => {
    expect(
      formatDiscordPermissionList([
        "VIEW_CHANNEL",
        "SEND_MESSAGES",
        "EMBED_LINKS",
        "ATTACH_FILES",
        "READ_MESSAGE_HISTORY",
        "CREATE_PUBLIC_THREADS",
        "SEND_MESSAGES_IN_THREADS",
        "USE_EXTERNAL_APPS",
      ]),
    ).toBe(
      "View Channel, Send Messages, Embed Links, Attach Files, Read Message History, Create Public Threads, Send Messages in Threads, USE_EXTERNAL_APPS",
    );
  });

  it("explains why a Discord channel cannot be selected", () => {
    expect(
      getDiscordChannelBlockReason({
        canActivate: true,
        missingPermissions: ["SEND_MESSAGES"],
      }),
    ).toBeNull();
    expect(
      getDiscordChannelBlockReason({
        canActivate: false,
        missingPermissions: [
          "VIEW_CHANNEL",
          "SEND_MESSAGES",
          "EMBED_LINKS",
          "ATTACH_FILES",
          "READ_MESSAGE_HISTORY",
          "CREATE_PUBLIC_THREADS",
          "SEND_MESSAGES_IN_THREADS",
        ],
      }),
    ).toEqual({ kind: "no_access" });
    expect(
      getDiscordChannelBlockReason({
        canActivate: false,
        missingPermissions: ["SEND_MESSAGES", "ATTACH_FILES"],
      }),
    ).toEqual({
      kind: "missing_permissions",
      label: "Send Messages, Attach Files",
    });
  });

  it("surfaces Discord lifecycle error codes in channel metadata", () => {
    expect(
      getDiscordChannelMetadata(
        connection({
          id: "discord",
          integration_type: "discord_channel",
          name: "Discord",
          config: {
            status: "disconnected",
            error_code: "guild_removed",
          },
        }),
      ),
    ).toMatchObject({
      status: "disconnected",
      error_code: "guild_removed",
    });
  });
});

describe("getChannelAttentionBadge", () => {
  it.each([
    [
      "pending_channel",
      {
        label: "Finish setup",
        tooltip:
          "Camel is installed in Camel HQ but no channel is selected yet.",
      },
    ],
    [
      "disconnected",
      {
        label: "Disconnected",
        tooltip: "Camel is not connected to a channel. Open to reconnect.",
      },
    ],
    [
      "setup_error",
      {
        label: "Setup error",
        tooltip: "Something went wrong during setup. Open to retry.",
      },
    ],
  ])("returns the expected Discord badge for %s", (status, expected) => {
    expect(
      getChannelAttentionBadge(
        connection({
          id: "discord",
          integration_type: "discord_channel",
          name: "Discord",
          config: { status, guild_name: "Camel HQ" },
        }),
      ),
    ).toEqual(expected);
  });

  it("returns a setup badge for pending Telegram and null for healthy channels", () => {
    expect(
      getChannelAttentionBadge(
        connection({
          id: "telegram",
          integration_type: "telegram",
          name: "Telegram",
          config: { status: "pending" },
        }),
      ),
    ).toEqual({
      label: "Finish setup",
      tooltip: "Open to finish linking your Telegram chat.",
    });

    expect(
      getChannelAttentionBadge(
        connection({
          id: "discord",
          integration_type: "discord_channel",
          name: "Discord",
          config: { status: "active" },
        }),
      ),
    ).toBeNull();
    expect(
      getChannelAttentionBadge(
        connection({
          id: "slack",
          integration_type: "slack",
          name: "Slack",
        }),
      ),
    ).toBeNull();
  });
});
