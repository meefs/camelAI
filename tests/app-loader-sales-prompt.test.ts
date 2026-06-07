import { beforeEach, describe, expect, it, vi } from "vitest";

const requireAuthContextMock = vi.fn();
const getEnvMock = vi.fn();
const getWorkspaceMigrationGateMock = vi.fn(() => null);

vi.mock("@/lib/auth.server", () => ({
  requireAuthContext: requireAuthContextMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/workspace-migration-gate.server", () => ({
  getWorkspaceMigrationGate: getWorkspaceMigrationGateMock,
}));

vi.mock("@/lib/billing.server", () => ({
  getVerifiedLegacyStripeMigrationEligibility: vi.fn(() => null),
  isOrgBillingAccessReady: vi.fn(
    (access: { kind: string }) => access.kind === "ready",
  ),
  resolveOrgBillingAccess: vi.fn(
    ({
      org,
      llmProviderConfig,
      pathname,
    }: {
      org: {
        billing_status?: string | null;
        billing_credit_purchase_total_cents?: number | null;
        billing_credit_grant_total_cents?: number | null;
      };
      llmProviderConfig?: unknown;
      pathname?: string;
    }) => {
      const setupRouteAccessible =
        pathname === "/settings/organization/billing" ||
        pathname === "/settings/organization/usage";
      const ready =
        org.billing_status === "trialing" ||
        org.billing_status === "active" ||
        org.billing_status === "enterprise" ||
        Boolean(llmProviderConfig) ||
        (org.billing_credit_purchase_total_cents ?? 0) +
          (org.billing_credit_grant_total_cents ?? 0) >
          0;
      return ready
        ? { kind: "ready", mode: "subscription", setupRouteAccessible: true }
        : {
            kind: "setup_required",
            reason: "missing_llm_provider",
            setupRouteAccessible,
          };
    },
  ),
  hasOrgUsedSubscriptionTrial: vi.fn(
    (org: {
      billing_trial_started_at?: number | null;
      billing_trial_ends_at?: number | null;
      billing_trial_credit_granted_at?: number | null;
    }) =>
      Boolean(
        org.billing_trial_started_at ||
          org.billing_trial_ends_at ||
          org.billing_trial_credit_granted_at,
      ),
  ),
}));

vi.mock("@/lib/chat-groups.server", () => ({
  listGroupsForWorkspace: vi.fn(() => Promise.resolve([])),
}));

const { loader, shouldRevalidate } = await import("@/routes/_app");

describe("_app loader onboarding redirect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getEnvMock.mockReturnValue({});
    requireAuthContextMock.mockResolvedValue({
      onboarding: { completed_at: null },
      emailVerification: { required: false, verified: true },
      user: { id: "user_123" },
      currentOrg: { id: "org_123" },
      currentWorkspace: { id: "ws_123" },
      orgs: [],
      workspaces: [],
      allWorkspaces: [],
      orgWorkspaceCount: 1,
      resignedSessionCookie: null,
    });
  });

  it("skips layout revalidation after create-and-start new chat submissions", () => {
    const formData = new FormData();
    formData.set("intent", "createThreadAndStart");

    expect(
      shouldRevalidate({
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(false);
  });

  it("keeps default layout revalidation for other submissions", () => {
    const formData = new FormData();
    formData.set("intent", "createThread");

    expect(
      shouldRevalidate({
        formData,
        defaultShouldRevalidate: true,
      }),
    ).toBe(true);
  });

  it("redirects incomplete users to /onboarding without prompt_key", async () => {
    await expect(
      loader({
        request: new Request(
          "https://camelai.dev/chat?prompt_key=sales-key-123",
        ),
        context: {},
      } as never),
    ).rejects.toSatisfy((response: unknown) => {
      return (
        response instanceof Response &&
        response.status === 302 &&
        response.headers.get("Location") === "/onboarding"
      );
    });
  });

  it("returns paywall context for onboarded users without org billing access", async () => {
    const org = {
      id: "org_free",
      name: "Org B",
      slug: "org-b",
      created_at: Date.now(),
      created_by: "user_123",
      billing_status: "inactive",
      billing_plan: "free",
      billing_seat_count: 1,
      billing_customer_id: null,
      billing_subscription_id: null,
      billing_subscription_status: null,
      billing_trial_started_at: null,
      billing_trial_ends_at: null,
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
      billing_trial_credit_grant_cents: 0,
      billing_trial_credit_granted_at: null,
      billing_last_included_credit_invoice_id: null,
      billing_credit_usage_started_at: null,
      archived: false,
      archived_at: null,
      archived_by: null,
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue(org),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
    };
    getEnvMock.mockReturnValue({
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    });
    requireAuthContextMock.mockResolvedValue({
      onboarding: { completed_at: Date.now() },
      emailVerification: { required: false, verified: true },
      user: { id: "user_123", email: "ada@example.com" },
      session: { user_id: "user_123", user_email: "ada@example.com" },
      currentOrg: org,
      currentWorkspace: { id: "ws_123" },
      orgs: [
        { org_id: "org_paid", org_name: "Org A", role: "owner" },
        { org_id: "org_free", org_name: "Org B", role: "owner" },
      ],
      workspaces: [],
      allWorkspaces: [],
      orgWorkspaceCount: 1,
      resignedSessionCookie: null,
    });

    const result = await loader({
      request: new Request("https://camelai.dev/chat"),
      context: {},
    } as never);

    expect(result).toMatchObject({
      billingAccessReady: false,
      appRouteAccessible: false,
      paywallContext: {
        currentOrgName: "Org B",
        multiOrg: true,
        byokProviderLabel: null,
      },
    });
    expect(orgStub.getLlmProviderConfig).toHaveBeenCalled();
  });

  it("allows billing setup routes for onboarded users without org billing access", async () => {
    const org = {
      id: "org_payg",
      name: "Payg Org",
      slug: "payg-org",
      created_at: Date.now(),
      created_by: "user_123",
      billing_status: "inactive",
      billing_plan: "payg",
      billing_seat_count: 1,
      billing_customer_id: null,
      billing_subscription_id: null,
      billing_subscription_status: null,
      billing_trial_started_at: null,
      billing_trial_ends_at: null,
      billing_credit_purchase_total_cents: 0,
      billing_credit_grant_total_cents: 0,
      billing_trial_credit_grant_cents: 0,
      billing_trial_credit_granted_at: null,
      billing_last_included_credit_invoice_id: null,
      billing_credit_usage_started_at: null,
      archived: false,
      archived_at: null,
      archived_by: null,
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue(org),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
    };
    getEnvMock.mockReturnValue({
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    });
    requireAuthContextMock.mockResolvedValue({
      onboarding: { completed_at: Date.now() },
      emailVerification: { required: false, verified: true },
      user: { id: "user_123", email: "ada@example.com" },
      session: { user_id: "user_123", user_email: "ada@example.com" },
      currentOrg: org,
      currentWorkspace: { id: "ws_123" },
      orgs: [{ org_id: "org_payg", org_name: "Payg Org", role: "owner" }],
      workspaces: [],
      allWorkspaces: [],
      orgWorkspaceCount: 1,
      resignedSessionCookie: null,
    });

    const result = await loader({
      request: new Request(
        "https://camelai.dev/settings/organization/usage?action=topup",
      ),
      context: {},
    } as never);

    expect(result).toMatchObject({
      billingAccessReady: false,
      appRouteAccessible: true,
      paywallContext: {
        currentOrgName: "Payg Org",
      },
    });
  });

  it("checks computer route workspace for project migration when the user can access it", async () => {
    const org = {
      id: "org_123",
      name: "Org",
      billing_status: "active",
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue(org),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
    };
    getEnvMock.mockReturnValue({
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    });
    requireAuthContextMock.mockResolvedValue({
      onboarding: { completed_at: Date.now() },
      emailVerification: { required: false, verified: true },
      user: { id: "user_123", email: "ada@example.com" },
      session: { user_id: "user_123", user_email: "ada@example.com" },
      currentOrg: org,
      currentWorkspace: { id: "ws_current" },
      orgs: [{ org_id: "org_123", org_name: "Org", role: "owner" }],
      workspaces: [{ id: "ws_current" }],
      allWorkspaces: [{ id: "ws_current" }, { id: "ws_target" }],
      orgWorkspaceCount: 2,
      resignedSessionCookie: null,
    });

    await loader({
      request: new Request("https://camelai.dev/computer/ws_target"),
      context: {},
    } as never);

    expect(getWorkspaceMigrationGateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "ws_target" }),
    );
  });

  it("does not check inaccessible computer route workspaces for project migration", async () => {
    const org = {
      id: "org_123",
      name: "Org",
      billing_status: "active",
    };
    const orgStub = {
      getInfo: vi.fn().mockResolvedValue(org),
      getLlmProviderConfig: vi.fn().mockResolvedValue(null),
    };
    getEnvMock.mockReturnValue({
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      APP_KV: {
        get: vi.fn().mockResolvedValue(null),
      },
    });
    requireAuthContextMock.mockResolvedValue({
      onboarding: { completed_at: Date.now() },
      emailVerification: { required: false, verified: true },
      user: { id: "user_123", email: "ada@example.com" },
      session: { user_id: "user_123", user_email: "ada@example.com" },
      currentOrg: org,
      currentWorkspace: { id: "ws_current" },
      orgs: [{ org_id: "org_123", org_name: "Org", role: "owner" }],
      workspaces: [{ id: "ws_current" }],
      allWorkspaces: [{ id: "ws_current" }],
      orgWorkspaceCount: 1,
      resignedSessionCookie: null,
    });

    await loader({
      request: new Request("https://camelai.dev/computer/ws_foreign"),
      context: {},
    } as never);

    expect(getWorkspaceMigrationGateMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: "ws_current" }),
    );
  });

});
