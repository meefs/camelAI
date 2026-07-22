import { describe, expect, it } from "vitest";

import { buildAppWorkSystemMessage } from "../src/lib/app-chat-context";

describe("app chat context", () => {
  it("points linked apps at durable project discovery", () => {
    const message = buildAppWorkSystemMessage({
      scriptName: "orders-app",
      appUrl: "https://orders-app.camelai.app",
      projectId: "project-123",
    });

    expect(message).toContain('source project id is "project-123"');
    expect(message).toContain('location "project"');
    expect(message).not.toMatch(/VM checkout|wrangler\.(toml|jsonc)|home folder/i);
  });

  it("uses project and app metadata when a source link is missing", () => {
    const message = buildAppWorkSystemMessage({
      scriptName: "legacy-name",
      appUrl: "https://legacy-name.camelai.app",
    });

    expect(message).toContain("list_projects");
    expect(message).toContain("list_apps");
    expect(message).toContain("Do not search VM or local filesystem paths");
  });
});
