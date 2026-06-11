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

  it("does not read the runtime clone response body on success", async () => {
    const sourceProject = {
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
    const cloneProject = {
      ...sourceProject,
      id: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app-copy",
      name: "web-app-copy",
      description: "Clone of web-app.",
      clonedFromProjectId: sourceProject.id,
      createdAt: "2026-06-06T00:01:00.000Z",
      updatedAt: "2026-06-06T00:01:00.000Z",
    };
    const cancel = vi.fn(async () => undefined);
    const text = vi.fn(() => {
      throw new Error("clone success body should not be read");
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      body: { cancel },
      text,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const workspaceCloneProject = vi.fn(async () => cloneProject);
    const bridge = new ProjectRuntimeServiceVmBridge({
      env: {
        PROJECT_RUNTIME_SERVICE_URL: "http://runtime.test",
      },
      workspace: {
        getProjectByName: vi.fn(async (name: string) =>
          name === "web-app" ? sourceProject : null
        ),
        cloneProject: workspaceCloneProject,
      } as never,
    });

    await expect(
      bridge.cloneProject({ sourceProject: "web-app", name: "web-app-copy" }),
    ).resolves.toEqual({
      success: true,
      project: "web-app-copy",
    });

    expect(workspaceCloneProject).toHaveBeenCalledWith({
      sourceProject: "web-app",
      name: "web-app-copy",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![0]).toBe(
      "http://runtime.test/v1/projects/ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app/clone",
    );
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      targetProjectId: "ca-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-web-app-copy",
    });
    expect(text).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
