import { describe, expect, it, vi } from "vitest";
import {
  createDeterministicAutomationRuntimeBindings,
} from "../src/deterministic-automation-workflow";

describe("DeterministicAutomationWorkflow", () => {
  it("uses exported entrypoint factories when ctx.exports is available", () => {
    const tools = {};
    const connections = {};
    const ai = {};
    const camelai = {};
    const exports = {
      CodeModeToolsBinding: vi.fn(() => tools),
      ConnectionsService: vi.fn(() => connections),
      AIVirtualBinding: vi.fn(() => ai),
      CamelAiService: vi.fn(() => camelai),
    };
    const bindings = createDeterministicAutomationRuntimeBindings({
      ctx: { exports },
      orgId: "org1",
      workspaceId: "workspace1",
      userId: "user1",
    });

    const props = {
      props: { orgId: "org1", workspaceId: "workspace1", userId: "user1" },
    };
    expect(bindings).toEqual({
      TOOLS: tools,
      CONNECTIONS: connections,
      AI: ai,
      CAMELAI: camelai,
    });
    expect(exports.CodeModeToolsBinding).toHaveBeenCalledWith(props);
    expect(exports.ConnectionsService).toHaveBeenCalledWith(props);
    expect(exports.AIVirtualBinding).toHaveBeenCalledWith(props);
    expect(exports.CamelAiService).toHaveBeenCalledWith(props);
  });

  it("falls back to serializable context without ctx.exports", () => {
    const bindings = createDeterministicAutomationRuntimeBindings({
      ctx: {},
      orgId: "org1",
      workspaceId: "workspace1",
      userId: "user1",
    });

    expect(bindings).toEqual({
      AUTOMATION_CONTEXT: {
        orgId: "org1",
        workspaceId: "workspace1",
        userId: "user1",
      },
    });
  });
});
