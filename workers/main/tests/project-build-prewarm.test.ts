import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the (namespace, key, opts) getSandbox is called with and hand back a
// fake sandbox whose exec we can drive per-test. Mocked at module load so the
// prewarm helpers never touch a real Cloudflare Container.
const execMock = vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
const getSandboxMock = vi.fn(() => ({ exec: execMock }));

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: (...args: unknown[]) => getSandboxMock(...args),
}));

import {
  prewarmProjectBuildSandbox,
  prewarmWorkspaceBuildSandboxes,
  projectBuildSandboxKey,
} from "../src/project-build-service";

const SANDBOX_NS = { __brand: "sandbox-namespace" } as never;

function fakeWorkspaceEnv(projects: Array<{ id: string; backend?: string }>) {
  const stub = { listProjects: vi.fn(async () => projects) };
  return {
    env: {
      PROJECT_BUILD_SANDBOX: SANDBOX_NS,
      WORKSPACE_FS: {
        idFromName: (name: string) => name,
        get: () => stub,
      } as never,
      R2_BUCKET: {} as never,
    },
    listProjects: stub.listProjects,
  };
}

beforeEach(() => {
  execMock.mockClear();
  execMock.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  getSandboxMock.mockClear();
});

describe("prewarmProjectBuildSandbox", () => {
  it("boots the per-(org, project) container with a no-op command", async () => {
    const result = await prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "Org A",
      projectId: "Demo_Project",
    });

    expect(result).toBe(true);
    expect(getSandboxMock).toHaveBeenCalledTimes(1);
    // Reuses the exact key runProjectBuild/deploy acquire, so the warm instance
    // is the one the build lands on.
    expect(getSandboxMock).toHaveBeenCalledWith(
      SANDBOX_NS,
      projectBuildSandboxKey("Org A", "Demo_Project"),
      expect.objectContaining({ normalizeId: true, transport: "rpc" }),
    );
    // @cloudflare/sandbox honors `timeout` (ms), not `timeoutMs`.
    expect(execMock).toHaveBeenCalledWith("true", expect.objectContaining({ timeout: expect.any(Number) }));
  });

  it("no-ops without the container binding and never touches getSandbox", async () => {
    const result = await prewarmProjectBuildSandbox({
      env: {},
      orgId: "org",
      projectId: "p1",
    });

    expect(result).toBe(false);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it("returns false for a missing org scope", async () => {
    const result = await prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "   ",
      projectId: "p1",
    });

    expect(result).toBe(false);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it("swallows container errors so a warm failure can't break the turn", async () => {
    execMock.mockRejectedValueOnce(new Error("container busy"));

    const result = await prewarmProjectBuildSandbox({
      env: { PROJECT_BUILD_SANDBOX: SANDBOX_NS },
      orgId: "org",
      projectId: "p1",
    });

    expect(result).toBe(false);
  });
});

describe("prewarmWorkspaceBuildSandboxes", () => {
  it("warms only DO-backed projects and skips legacy vm projects", async () => {
    const { env } = fakeWorkspaceEnv([
      { id: "app-one", backend: "do-r2" },
      { id: "legacy", backend: "vm" },
      { id: "app-two", backend: "do-r2" },
      { id: "unset" }, // defaults to vm
    ]);

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1");

    expect(warmed).toBe(2);
    expect(getSandboxMock).toHaveBeenCalledTimes(2);
    const keys = getSandboxMock.mock.calls.map((call) => call[1]);
    expect(keys).toEqual([
      projectBuildSandboxKey("acme", "app-one"),
      projectBuildSandboxKey("acme", "app-two"),
    ]);
  });

  it("warms DO-backed clones nested under their source project", async () => {
    // listProjects() folds clones into the source's `clones` array; deploy still
    // builds a clone under its own id, so its sandbox key must be warmed too.
    const stub = {
      listProjects: vi.fn(async () => [
        {
          id: "source",
          backend: "do-r2",
          clones: [
            { id: "clone-do", backend: "do-r2" },
            { id: "clone-vm", backend: "vm" },
          ],
        },
        { id: "legacy", backend: "vm", clones: [{ id: "clone-of-legacy", backend: "do-r2" }] },
      ]),
    };
    const env = {
      PROJECT_BUILD_SANDBOX: SANDBOX_NS,
      WORKSPACE_FS: { idFromName: (n: string) => n, get: () => stub } as never,
      R2_BUCKET: {} as never,
    };

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1");

    expect(warmed).toBe(3);
    const keys = getSandboxMock.mock.calls.map((call) => call[1]);
    expect(keys).toEqual([
      projectBuildSandboxKey("acme", "source"),
      projectBuildSandboxKey("acme", "clone-do"),
      projectBuildSandboxKey("acme", "clone-of-legacy"),
    ]);
  });

  it("returns 0 and skips getSandbox when there are no DO-backed projects", async () => {
    const { env } = fakeWorkspaceEnv([{ id: "legacy", backend: "vm" }]);

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1");

    expect(warmed).toBe(0);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });

  it("caps the number of containers warmed per workspace", async () => {
    const projects = Array.from({ length: 8 }, (_, i) => ({ id: `app-${i}`, backend: "do-r2" }));
    const { env } = fakeWorkspaceEnv(projects);

    const warmed = await prewarmWorkspaceBuildSandboxes(env, "acme", "ws-1", { maxTargets: 3 });

    expect(warmed).toBe(3);
    expect(getSandboxMock).toHaveBeenCalledTimes(3);
  });

  it("returns 0 without the container binding", async () => {
    const { env } = fakeWorkspaceEnv([{ id: "app-one", backend: "do-r2" }]);
    const warmed = await prewarmWorkspaceBuildSandboxes(
      { ...env, PROJECT_BUILD_SANDBOX: undefined },
      "acme",
      "ws-1",
    );

    expect(warmed).toBe(0);
    expect(getSandboxMock).not.toHaveBeenCalled();
  });
});
