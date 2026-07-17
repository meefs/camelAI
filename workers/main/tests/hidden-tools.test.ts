import { describe, expect, it } from "vitest";

import { CodeModeToolsBinding } from "../src/code-mode-tools.js";

/**
 * Deprecated alias tools must stay CALLABLE (they remain in listTools, so the
 * js_exec `tools.*` facade keeps the property and old transcripts/snippets keep
 * working) while being HIDDEN from every discovery surface (help/search/describe
 * in the runner, the js_exec prompt inventory, and Pi top-level registration all
 * filter on `hidden`).
 */
describe("hidden source-compat alias tools", () => {
  it("keeps warehouse aliases registered (callable) but flagged hidden", async () => {
    const tools = await CodeModeToolsBinding.prototype.listTools.call({} as never);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const alias of ["warehouse_run_code", "warehouse_list_connections"]) {
      const tool = byName.get(alias);
      expect(tool, `${alias} must stay registered for the js_exec facade`).toBeDefined();
      expect(tool?.hidden, `${alias} must be hidden from discovery`).toBe(true);
    }
  });

  it("leaves the canonical analysis tools discoverable", async () => {
    const tools = await CodeModeToolsBinding.prototype.listTools.call({} as never);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const name of [
      "run_notebook",
      "run_code",
      "analysis_exec",
      "add_python_dependency",
      "analysis_list_connections",
    ]) {
      const tool = byName.get(name);
      expect(tool, `${name} must be registered`).toBeDefined();
      expect(tool?.hidden, `${name} must be discoverable`).toBe(false);
    }
  });

  it("hides nothing else", async () => {
    const tools = await CodeModeToolsBinding.prototype.listTools.call({} as never);
    const hidden = tools.filter((tool) => tool.hidden).map((tool) => tool.name).sort();
    expect(hidden).toEqual(["build_project", "warehouse_list_connections", "warehouse_run_code"]);
  });
});
