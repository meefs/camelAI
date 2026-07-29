import { beforeEach, describe, expect, it, vi } from "vitest";

const requireSuperuserMock = vi.fn();
const getAuthEnvMock = vi.fn();
const getEnvMock = vi.fn();
const getOrgMock = vi.fn();
const getOrgMembersMock = vi.fn();
const getOrgInvitationsMock = vi.fn();
const adminGetWorkspacesByOrgMock = vi.fn();
const adminGetOrgRecentActivityMock = vi.fn();
const getOrgBanByIdMock = vi.fn();
const applyManualCreditGrantMock = vi.fn();
const getUsageSpendMock = vi.fn();
const getUsageLogMock = vi.fn();
const getUsageLogSumMock = vi.fn();
const listManualCreditGrantsMock = vi.fn();
const getLlmProviderConfigMock = vi.fn();
const listWorkerScriptsMock = vi.fn();
const getProfileMock = vi.fn();

vi.mock("@/lib/auth.server", () => ({
  requireSuperuser: requireSuperuserMock,
  getAuthEnv: getAuthEnvMock,
}));

vi.mock("@/lib/cloudflare.server", () => ({
  getEnv: getEnvMock,
}));

vi.mock("@/lib/wait-until", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/lib/auth-do", () => ({
  adminTransferOrgOwnership: vi.fn(),
  updateOrgMemberRole: vi.fn(),
  getOrg: getOrgMock,
  getOrgMembers: getOrgMembersMock,
  getOrgInvitations: getOrgInvitationsMock,
}));

vi.mock("@/lib/auth-do.server", () => ({
  addAdminOrgMember: vi.fn(),
  adminGetWorkspacesByOrg: adminGetWorkspacesByOrgMock,
  adminGetOrgRecentActivity: adminGetOrgRecentActivityMock,
  hardDeleteAdminOrg: vi.fn(),
  runAdminOrgBanAndPurgeWithEnv: vi.fn(),
  startAdminOrgBanAndPurgeWithEnv: vi.fn(),
}));

vi.mock("../workers/main/src/ban-list", () => ({
  getOrgBanById: getOrgBanByIdMock,
}));

vi.mock("@/lib/admin-custom-domain.server", () => ({
  refreshOrgCustomDomainHostnamesForAdmin: vi.fn(),
}));

const { loader, action } = await import("@/routes/_admin.orgs.$id");

function makeOrg() {
  return {
    id: "org_123",
    name: "Test Org",
    slug: "test-org",
    created_by: "user_owner",
    created_at: 1710000000000,
    billing_status: "active",
    billing_customer_id: "cus_test",
    billing_subscription_id: "sub_test",
    billing_subscription_status: "active",
    billing_trial_started_at: null,
    billing_trial_ends_at: null,
    billing_credit_purchase_total_cents: 5000,
    billing_credit_grant_total_cents: 2000,
    billing_trial_credit_grant_cents: 0,
    billing_trial_credit_granted_at: null,
    billing_last_included_credit_invoice_id: null,
    billing_credit_usage_started_at: null,
    archived: false,
    archived_at: null,
    archived_by: null,
  };
}

function makeRequest(formData?: URLSearchParams) {
  return new Request("https://camelai.com/qaml-backdoor/orgs/org_123", {
    method: formData ? "POST" : "GET",
    body: formData,
  });
}

describe("/qaml-backdoor/orgs/:id credit grants", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    const orgStub = {
      getUsageSpend: getUsageSpendMock,
      getUsageLog: getUsageLogMock,
      getUsageLogSum: getUsageLogSumMock,
      listManualCreditGrants: listManualCreditGrantsMock,
      getLlmProviderConfig: getLlmProviderConfigMock,
      listWorkerScripts: listWorkerScriptsMock,
      applyManualCreditGrant: applyManualCreditGrantMock,
    };

    requireSuperuserMock.mockResolvedValue({
      user: { id: "user_super", is_superuser: true },
    });
    getEnvMock.mockReturnValue({ APP_KV: {} });
    getAuthEnvMock.mockReturnValue({
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ getProfile: getProfileMock })),
      },
    });
    getOrgMock.mockResolvedValue(makeOrg());
    getOrgMembersMock.mockResolvedValue([]);
    getOrgInvitationsMock.mockResolvedValue([]);
    adminGetWorkspacesByOrgMock.mockResolvedValue([]);
    adminGetOrgRecentActivityMock.mockResolvedValue({
      threads: [],
      apps: [],
      threadCount: 0,
      appCount: 0,
    });
    getLlmProviderConfigMock.mockResolvedValue(null);
    listWorkerScriptsMock.mockResolvedValue([]);
    getOrgBanByIdMock.mockResolvedValue(null);
    getUsageSpendMock.mockResolvedValue({
      org_id: "org_123",
      total_cost_usd: 12.34,
      total_requests: 7,
      windows: [],
    });
    getUsageLogMock.mockResolvedValue({ entries: [] });
    getUsageLogSumMock.mockResolvedValue({
      org_id: "org_123",
      total_cost_usd: 12.34,
      total_requests: 7,
      total_input_tokens: 1,
      total_output_tokens: 2,
      total_cache_creation_input_tokens: 0,
      total_cache_read_input_tokens: 0,
    });
    listManualCreditGrantsMock.mockResolvedValue([
      {
        grant_id: "grant_1",
        amount_cents: 500,
        reason: "Low-credit alert testing",
        created_at: 1710000010000,
        created_by: "user_super",
        source: "qaml-backdoor",
      },
    ]);
    getProfileMock.mockResolvedValue({
      id: "user_super",
      email: "super@example.com",
      name: "Super User",
    });
    applyManualCreditGrantMock.mockResolvedValue({
      applied: true,
      grantId: "grant-form-1",
      amountCents: 500,
      reason: "Low-credit alert testing",
      createdAt: 1710000020000,
      createdBy: "user_super",
      source: "qaml-backdoor",
      org: makeOrg(),
    });
  });

  it("loader returns credit summary and recent credit grants", async () => {
    const result = await loader({
      request: makeRequest(),
      context: {},
      params: { id: "org_123" },
    } as never);

    expect(result.creditSummary).toEqual({
      purchaseTotalCents: 5000,
      grantTotalCents: 2000,
      totalCreditLimitCents: 7000,
      chargeableUsageCents: 1234,
      availableCreditsCents: 5766,
    });
    expect(result.creditGrants).toEqual([
      {
        grant_id: "grant_1",
        amount_cents: 500,
        reason: "Low-credit alert testing",
        created_at: 1710000010000,
        created_by: "user_super",
        source: "qaml-backdoor",
      },
    ]);
    expect(result.creditGrantUsers).toEqual([
      {
        id: "user_super",
        email: "super@example.com",
        name: "Super User",
      },
    ]);
  });

  it("loader preserves credit grant ledger read failures", async () => {
    listManualCreditGrantsMock.mockRejectedValueOnce(new Error("ledger offline"));

    const result = await loader({
      request: makeRequest(),
      context: {},
      params: { id: "org_123" },
    } as never);

    expect(result.creditGrants).toEqual([]);
    expect(result.creditGrantsUnavailable).toBe(true);
    expect(result.creditGrantsError).toBe("ledger offline");
  });

  it("action rejects non-superuser through requireSuperuser", async () => {
    const authResponse = new Response(null, { status: 302 });
    requireSuperuserMock.mockRejectedValue(authResponse);

    await expect(
      action({
        request: makeRequest(
          new URLSearchParams({
            intent: "grantCredits",
            amount: "5.00",
            idempotencyKey: "grant-form-1",
          }),
        ),
        context: {},
        params: { id: "org_123" },
      } as never),
    ).rejects.toBe(authResponse);
    expect(applyManualCreditGrantMock).not.toHaveBeenCalled();
  });

  it("action grants credits with authenticated superuser as created_by", async () => {
    const result = await action({
      request: makeRequest(
        new URLSearchParams({
          intent: "grantCredits",
          amount: "5.00",
          reason: "Low-credit alert testing",
          idempotencyKey: "grant-form-1",
        }),
      ),
      context: {},
      params: { id: "org_123" },
    } as never);

    expect(applyManualCreditGrantMock).toHaveBeenCalledWith(
      500,
      "Low-credit alert testing",
      "grant-form-1",
      { createdBy: "user_super", source: "qaml-backdoor" },
    );
    expect(result).toMatchObject({
      success: true,
      creditGrant: {
        grantId: "grant-form-1",
        amountCents: 500,
        createdBy: "user_super",
        source: "qaml-backdoor",
      },
    });
  });

  it.each(["", "0", "-1", "1.234", "10000.01"])(
    "action rejects invalid amount %s",
    async (amount) => {
      const result = await action({
        request: makeRequest(
          new URLSearchParams({
            intent: "grantCredits",
            amount,
            idempotencyKey: "grant-form-1",
          }),
        ),
        context: {},
        params: { id: "org_123" },
      } as never);

      expect(result).toMatchObject({ error: expect.any(String) });
      expect(applyManualCreditGrantMock).not.toHaveBeenCalled();
    },
  );

  it("action ignores forged created_by and source form fields", async () => {
    await action({
      request: makeRequest(
        new URLSearchParams({
          intent: "grantCredits",
          amount: "5.00",
          reason: "Low-credit alert testing",
          idempotencyKey: "grant-form-1",
          created_by: "attacker",
          source: "admin-api",
        }),
      ),
      context: {},
      params: { id: "org_123" },
    } as never);

    expect(applyManualCreditGrantMock).toHaveBeenCalledWith(
      500,
      "Low-credit alert testing",
      "grant-form-1",
      { createdBy: "user_super", source: "qaml-backdoor" },
    );
  });
});
