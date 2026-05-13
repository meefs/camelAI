import { describe, expect, it, vi } from "vitest";
import { PiContainerTools } from "../src/pi-container-tools";
import type { WorkspaceContainer } from "../src/workspace-container";

describe("PiContainerTools", () => {
  it("passes Wrangler deploy proxy env to bash executions", async () => {
    const execOnSandbox = vi.fn(async () => ({
      success: true,
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    }));
    const workspace = { execOnSandbox } as unknown as WorkspaceContainer;
    const tools = new PiContainerTools(workspace, {
      commandEnv: async () => ({
        CLOUDFLARE_API_BASE_URL: "https://camelai.dev/client/v4",
        CLOUDFLARE_API_TOKEN: "st_token",
        CLOUDFLARE_ACCOUNT_ID: "acct_1",
      }),
    });

    const result = await tools.callTool("bash", {
      command: "wrangler deploy --dispatch-namespace chiridion",
    });

    expect(result.text).toBe("ok");
    expect(execOnSandbox).toHaveBeenCalledWith(
      ["bash", "-lc", "wrangler deploy --dispatch-namespace chiridion"],
      {
        cwd: "/home/claude",
        env: {
          CLOUDFLARE_API_BASE_URL: "https://camelai.dev/client/v4",
          CLOUDFLARE_API_TOKEN: "st_token",
          CLOUDFLARE_ACCOUNT_ID: "acct_1",
        },
      },
    );
  });
});
