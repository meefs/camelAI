import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  createDeterministicAutomationRuntimeBindings,
  prepareDeterministicAutomationRuntimeSource,
} from "../src/deterministic-automation-workflow";

const WORKFLOW_COMPATIBILITY_DATE = "2026-05-18";

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

  it("wraps workflow source with a local connection method facade", () => {
    const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const admin = await this.env.CONNECTIONS.find("admin");
    return await this.env.CONNECTIONS[admin.alias].getDashboardSummary({
      date: "2026-05-29",
      exclude_spam: true,
    });
  }
}
`;

    const wrapped = prepareDeterministicAutomationRuntimeSource(source);

    expect(wrapped).toContain("function __camelAiCreateConnectionsFacade(binding)");
    expect(wrapped).toContain(
      "class __CamelAiUserAutomationWorkflow extends WorkflowEntrypoint",
    );
    expect(wrapped).toContain(
      "export class AutomationWorkflow extends __CamelAiUserAutomationWorkflow",
    );
    expect(wrapped).toContain("method: methodName");
    expect(wrapped).toContain("connection: connectionName");
    expect(wrapped).toContain("getDashboardSummary");
  });

  it("installs the connection facade inside a dynamic workflow worker", async () => {
    const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run() {
    try {
      await this.env.CONNECTIONS.remoteMcpAdmin.getDashboardSummary({
        date: "2026-05-29",
        exclude_spam: true,
      });
      return { called: true };
    } catch (error) {
      return { called: true, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
`;
    const loader = env.CODE_MODE_LOADER as WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    };
    expect(loader?.load, "CODE_MODE_LOADER binding is required").toBeTypeOf("function");
    const worker = loader.load!({
      compatibilityDate: WORKFLOW_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: prepareDeterministicAutomationRuntimeSource(source) },
      },
      env: { CONNECTIONS: {} },
    });
    const runner = worker.getEntrypoint("AutomationWorkflow") as unknown as {
      run(): Promise<unknown>;
    };

    await expect(runner.run()).resolves.toEqual({
      called: true,
      error: "CONNECTIONS method invocation is not configured",
    });
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
