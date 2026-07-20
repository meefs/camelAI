import { describe, expect, it } from "vitest";
import { getConnectionContract } from "@/lib/connection-contract";
import { getAllIntegrations } from "@/lib/integration-registry";
import type { WorkspaceIntegrationDefinition } from "@/lib/integration-definition";

describe("connection contracts", () => {
  it("assigns every setup type exactly one execution and verification strategy", () => {
    for (const definition of getAllIntegrations()) {
      const contract = getConnectionContract(definition.type, {
        config: definition.type === "other" ? { base_url: "https://api.example.com" } : {},
      });
      expect(contract.integrationType).toBe(definition.type);
      expect(contract.driver).toBeTruthy();
      expect(contract.verification.strategy).toBeTruthy();
      expect(new Set(contract.capabilities).size).toBe(contract.capabilities.length);
    }
  });

  it("does not advertise generic fetch for credential-only providers", () => {
    expect(getConnectionContract("openai").capabilities).toEqual(["project_credentials"]);
    expect(getConnectionContract("aws").capabilities).toEqual(["project_credentials"]);
    expect(getConnectionContract("square").capabilities).toEqual(["project_credentials"]);
    expect(getConnectionContract("openai").permissions).toEqual({ read: false, write: false });
  });

  it("keeps generic fetch as the Other fallback only after a base URL exists", () => {
    expect(getConnectionContract("other").capabilities).toEqual([]);
    expect(getConnectionContract("other", {
      config: { base_url: "https://api.example.com" },
    }).capabilities).toEqual(["authenticated_fetch"]);
  });

  it("classifies specialized families consistently", () => {
    expect(getConnectionContract("postgres")).toMatchObject({
      driver: "sql",
      capabilities: ["query_database", "mcp_tools"],
      verification: { strategy: "database_query", live: true },
    });
    expect(getConnectionContract("google_analytics")).toMatchObject({
      driver: "curated",
      capabilities: ["typed_operations"],
      permissions: { read: true, write: false },
    });
    expect(getConnectionContract("remote_mcp")).toMatchObject({
      driver: "remote_mcp",
      capabilities: ["mcp_tools"],
    });
    expect(getConnectionContract("databricks")).toMatchObject({
      driver: "sql",
      capabilities: ["query_database", "mcp_tools"],
      verification: { strategy: "mcp_discovery", live: true },
    });
  });

  it("advertises imported writes only when the connection enables them", () => {
    const definition = {
      schemaVersion: 1,
      slug: "example",
      displayName: "Example",
      surface: "openapi",
      source: "imported",
      sourceUrl: "https://api.example.com/openapi.json",
      baseUrl: "https://api.example.com",
      auth: [],
      operations: [
        { id: "list_items", name: "list_items", method: "GET", path: "/items", access: "read" },
        { id: "create_item", name: "create_item", method: "POST", path: "/items", access: "write" },
      ],
      provenance: { kind: "discovered" },
    } satisfies WorkspaceIntegrationDefinition;

    expect(getConnectionContract("other", { definition }).permissions).toEqual({
      read: true,
      write: false,
    });
    expect(getConnectionContract("other", {
      config: { operation_policy: "all" },
      definition,
    }).permissions).toEqual({ read: true, write: true });
  });
});
