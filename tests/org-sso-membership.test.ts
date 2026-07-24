import { describe, expect, it, vi } from "vitest";
import { ensureOrgMembership } from "../src/lib/org-sso.server";

function authEnvWithWorkspaces(workspaces: Array<{ id: string; archived: boolean }>) {
  const setOrgLastWorkspace = vi.fn(async () => undefined);
  const orgStub = {
    getMember: vi.fn(async () => ({ user_id: "user-1", role: "member", joined_at: Date.now() })),
    listUserWorkspaces: vi.fn(async () => workspaces),
  };
  const userStub = {
    getOrgs: vi.fn(async () => [{ org_id: "org-1", role: "member", last_workspace_id: "restricted" }]),
    hasOrg: vi.fn(async () => true),
    addOrg: vi.fn(async () => undefined),
    setOrgLastWorkspace,
  };
  const namespace = (stub: object) => ({
    idFromName: (id: string) => id,
    get: () => stub,
  });
  return {
    env: {
      ORG: namespace(orgStub),
      USER: namespace(userStub),
      WORKSPACE: {
        idFromName: (id: string) => id,
        get: () => { throw new Error("SSO login must not mutate workspace permissions"); },
      },
    } as never,
    orgStub,
    userStub,
    setOrgLastWorkspace,
  };
}

describe("enterprise SSO membership reconciliation", () => {
  it("does not restore access to a workspace excluded by the authorization source of truth", async () => {
    const fixture = authEnvWithWorkspaces([]);
    await expect(ensureOrgMembership(
      fixture.env,
      { id: "org-1" } as never,
      "user-1",
    )).resolves.toBeNull();
    expect(fixture.orgStub.listUserWorkspaces).toHaveBeenCalledWith("user-1");
    expect(fixture.setOrgLastWorkspace).not.toHaveBeenCalled();
  });

  it("selects an authorized workspace without changing its access level", async () => {
    const fixture = authEnvWithWorkspaces([{ id: "allowed", archived: false }]);
    await expect(ensureOrgMembership(
      fixture.env,
      { id: "org-1" } as never,
      "user-1",
    )).resolves.toBe("allowed");
    expect(fixture.setOrgLastWorkspace).toHaveBeenCalledWith("org-1", "allowed");
  });
});
