import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const updateUserMock = vi.fn();
const updateWorkspaceMock = vi.fn();
const resetOnboardingForUserMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth-do", () => ({
  updateUser: updateUserMock,
  updateWorkspace: updateWorkspaceMock,
  resetOnboardingForUser: resetOnboardingForUserMock,
}));

const profileRoute = await import("@/routes/_app.settings.profile");
const workspaceRoute = await import("@/routes/_app.settings.workspace.general");

function postForm(entries: Record<string, string>) {
  const formData = new FormData();
  for (const [key, value] of Object.entries(entries)) {
    formData.set(key, value);
  }
  return new Request("https://camelai.com/settings", {
    method: "POST",
    body: formData,
  });
}

describe("settings avatar action intents", () => {
  const authEnv = {};

  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    getAuthEnvMock.mockReturnValue(authEnv);
    requireAuthContextMock.mockResolvedValue({
      user: { id: "user_1", is_superuser: false },
      currentWorkspace: { id: "workspace_1" },
    });
    updateUserMock.mockResolvedValue({});
    updateWorkspaceMock.mockResolvedValue({});
  });

  it("updates only the profile avatar without requiring a name", async () => {
    const result = await profileRoute.action({
      request: postForm({
        intent: "updateAvatar",
        avatarColor: "#7c3aed",
        avatarContent: "AB",
      }),
      context: {},
      params: {},
    } as never);

    expect(result).toEqual({
      success: true,
      avatar: { color: "#7C3AED", content: "AB" },
    });
    expect(updateUserMock).toHaveBeenCalledWith(authEnv, "user_1", {
      avatar: { color: "#7C3AED", content: "AB" },
    });
  });

  it("rejects invalid profile avatar values", async () => {
    const result = await profileRoute.action({
      request: postForm({
        intent: "updateAvatar",
        avatarColor: "red",
        avatarContent: "ABC",
      }),
      context: {},
      params: {},
    } as never);

    expect(result).toEqual({ error: "Invalid avatar" });
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("keeps profile avatar updates behind auth checks", async () => {
    requireAuthContextMock.mockRejectedValueOnce(new Error("Auth required"));

    await expect(
      profileRoute.action({
        request: postForm({
          intent: "updateAvatar",
          avatarColor: "#7C3AED",
          avatarContent: "AB",
        }),
        context: {},
        params: {},
      } as never),
    ).rejects.toThrow("Auth required");
    expect(updateUserMock).not.toHaveBeenCalled();
  });

  it("updates only the workspace avatar without requiring name or description", async () => {
    const result = await workspaceRoute.action({
      request: postForm({
        intent: "updateAvatar",
        avatarColor: "#10b981",
        avatarContent: "🧠",
      }),
      context: {},
      params: {},
    } as never);

    expect(result).toEqual({
      success: true,
      avatar: { color: "#10B981", content: "🧠" },
    });
    expect(updateWorkspaceMock).toHaveBeenCalledWith(
      authEnv,
      "workspace_1",
      { avatar: { color: "#10B981", content: "🧠" } },
      "user_1",
    );
  });

  it("rejects invalid workspace avatar values", async () => {
    const result = await workspaceRoute.action({
      request: postForm({
        intent: "updateAvatar",
        avatarColor: "#10B981",
        avatarContent: "ABC",
      }),
      context: {},
      params: {},
    } as never);

    expect(result).toEqual({ error: "Invalid avatar" });
    expect(updateWorkspaceMock).not.toHaveBeenCalled();
  });

  it("preserves workspace ownership enforcement in the update path", async () => {
    updateWorkspaceMock.mockRejectedValueOnce(new Error("Workspace access denied"));

    await expect(
      workspaceRoute.action({
        request: postForm({
          intent: "updateAvatar",
          avatarColor: "#10B981",
          avatarContent: "🧠",
        }),
        context: {},
        params: {},
      } as never),
    ).rejects.toThrow("Workspace access denied");
    expect(updateWorkspaceMock).toHaveBeenCalledWith(
      authEnv,
      "workspace_1",
      { avatar: { color: "#10B981", content: "🧠" } },
      "user_1",
    );
  });
});
