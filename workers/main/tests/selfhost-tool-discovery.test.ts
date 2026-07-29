import { describe, expect, it } from "vitest";

import { CodeModeToolsBinding } from "../src/code-mode-tools.js";
import { buildJsExecDescription } from "../src/chat-thread/pi-tools.js";

describe("self-host tool discovery", () => {
  it("removes outbound email from discovery and rejects direct calls", async () => {
    const binding = {
      env: { CF_ACCOUNT_ID: "selfhost" },
      ctx: { props: { allowWebTools: true } },
    } as never;
    const tools = await CodeModeToolsBinding.prototype.listTools.call(binding);

    expect(tools.map((tool) => tool.name)).not.toContain("send_email");
    expect(buildJsExecDescription(false)).not.toContain("send_email");
    await expect(
      CodeModeToolsBinding.prototype.callTool.call(binding, "send_email", {}),
    ).rejects.toThrow(
      "Outbound email is disabled in self-host mode. No SMTP transport is implemented.",
    );
  });
});
