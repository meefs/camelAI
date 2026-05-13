import { describe, expect, it, vi } from "vitest";
import { PiContainerTools } from "../src/pi-container-tools";
import type { WorkspaceContainer } from "../src/workspace-container";

describe("PiContainerTools", () => {
  it("writes files through the container exec path", async () => {
    const execOnSandbox = vi.fn(async () => ({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    }));
    const writeFile = vi.fn();
    const workspace = { execOnSandbox, writeFile } as unknown as WorkspaceContainer;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("write", {
      path: "/tmp/example.txt",
      content: "hello from container",
    });

    expect(result.text).toBe("Successfully wrote 20 bytes to /tmp/example.txt");
    expect(writeFile).not.toHaveBeenCalled();
    expect(execOnSandbox).toHaveBeenCalledTimes(1);
    const [cmd, options] = execOnSandbox.mock.calls[0];
    expect(cmd[0]).toBe("python3");
    expect(cmd[1]).toBe("-c");
    expect(cmd[3]).toBe("/tmp/example.txt");
    expect(Buffer.from(String(cmd[4]), "base64").toString("utf8")).toBe("hello from container");
    expect(options).toEqual({ cwd: "/home/claude" });
  });

  it("reads files through the container exec path with relative paths under the container home", async () => {
    const execOnSandbox = vi.fn(async () => ({
      success: true,
      stdout: JSON.stringify({
        success: true,
        content: "hello",
        size: 5,
        isBinary: false,
        mimeType: "text/plain",
      }),
      stderr: "",
      exitCode: 0,
    }));
    const readFile = vi.fn();
    const workspace = { execOnSandbox, readFile } as unknown as WorkspaceContainer;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("read", { path: "notes.txt" });

    expect(result.text).toBe("hello");
    expect(readFile).not.toHaveBeenCalled();
    const [cmd, options] = execOnSandbox.mock.calls[0];
    expect(cmd[3]).toBe("/home/claude/notes.txt");
    expect(options).toEqual({ cwd: "/home/claude" });
  });

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
