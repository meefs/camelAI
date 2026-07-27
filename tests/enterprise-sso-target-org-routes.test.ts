import { beforeEach, describe, expect, it, vi } from "vitest";

const getEnvMock = vi.fn();
const getSessionMock = vi.fn();
const requireAccessMappedOrgMock = vi.fn();
const isOrgAdminMock = vi.fn();
const getInvitationMock = vi.fn();
const getWorkerAccessInfoMock = vi.fn();
const isOrgMemberMock = vi.fn();
const r2GetMock = vi.fn();

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/auth.server", () => ({
  getSession: getSessionMock,
}));

vi.mock("@/lib/cloudflare-access-auth.server", () => ({
  requireAccessMappedOrg: requireAccessMappedOrgMock,
}));

vi.mock("@/lib/auth-do", () => ({
  createInvitations: vi.fn(),
  getInvitation: getInvitationMock,
  isOrgAdmin: isOrgAdminMock,
  getWorkerAccessInfo: getWorkerAccessInfoMock,
  isOrgMember: isOrgMemberMock,
}));

vi.mock("@/lib/email.server", () => ({
  buildInvitationUrl: vi.fn(),
  resolveAppBaseUrl: vi.fn(),
  sendOrgInvitationEmail: vi.fn(),
}));

const { action: invitationAction } = await import(
  "@/routes/api/orgs.$id.invite"
);
const { loader: appPreviewLoader } = await import(
  "@/routes/api/apps.$scriptName.preview"
);

describe("enterprise SSO target organization routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const orgStub = {
      getWorkerScript: vi.fn(),
    };
    getEnvMock.mockReturnValue({
      USER: {},
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      WORKSPACE: {},
      SESSIONS: {},
      EMAIL_TO_USER: {},
      APP_KV: {},
      TOKEN_SIGNING_SECRET: "secret",
      R2_BUCKET: { get: r2GetMock },
    });
    getSessionMock.mockResolvedValue({
      session: {
        user_id: "user-1",
        org_id: "org-1",
        auth_source: "enterprise_oidc",
      },
    });
  });

  it("rejects invitation mutations outside the signed SSO organization", async () => {
    requireAccessMappedOrgMock.mockResolvedValueOnce(
      Response.json(
        { error: "This SSO session is restricted to its organization" },
        { status: 403 },
      ),
    );

    const response = await invitationAction({
      request: new Request("https://camelai.test/api/orgs/org-2/invite", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "member@example.com", role: "member" }),
      }),
      context: {},
      params: { id: "org-2" },
    } as never);

    expect(response.status).toBe(403);
    expect(isOrgAdminMock).not.toHaveBeenCalled();
    expect(getInvitationMock).not.toHaveBeenCalled();
  });

  it("rejects private app previews outside the signed SSO organization", async () => {
    getWorkerAccessInfoMock.mockResolvedValueOnce({ org_id: "org-2" });

    const response = await appPreviewLoader({
      request: new Request(
        "https://camelai.test/api/apps/private-app.preview",
      ),
      context: {},
      params: { scriptName: "private-app" },
    } as never);

    expect(response.status).toBe(403);
    expect(isOrgMemberMock).not.toHaveBeenCalled();
    expect(r2GetMock).not.toHaveBeenCalled();
  });
});
