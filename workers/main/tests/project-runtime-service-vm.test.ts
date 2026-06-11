import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectRuntimeServiceVmBridge } from "../src/project-runtime-service-vm";

describe("ProjectRuntimeServiceVmBridge", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("executes user commands from /workspace by default", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    await bridge.exec({ project: "web-app", command: "pwd" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const userExecBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1]!.body),
    );
    expect(userExecBody).toMatchObject({
      cmd: ["bash", "-lc", "pwd"],
      cwd: "/workspace",
      env: {
        CAMELAI_CONNECTIONS_RPC_URL: "http://host.docker.internal:8089/p/camelai-connections-rpc/rpc/connections",
      },
    });
  });

  it("resolves explicit cwd relative to the project checkout", async () => {
    const project = {
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app",
      name: "web-app",
      description: "Web app.",
      defaultVmId: "main",
      artifactRemote: "https://artifacts.camelai.internal/git/web-app.git",
      artifactStatus: "ready",
      artifactDefaultBranch: "main",
      createdAt: "2026-06-06T00:00:00.000Z",
      updatedAt: "2026-06-06T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async () =>
      Response.json({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? project : null
        ),
      } as never,
    });

    await bridge.exec({ project: "web-app", command: "pwd", cwd: "/src" });

    const userExecBody = JSON.parse(
      String(fetchMock.mock.calls[1]![1]!.body),
    );
    expect(userExecBody.cwd).toBe("/workspace/src");
  });
});
