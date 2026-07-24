import { describe, expect, it } from "vitest";
import {
  buildConnectionGroups,
  deriveCapabilities,
  filterAndSortConnectionGroups,
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
