import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  backfillHostUsageToOrgDOs: vi.fn(),
}));

vi.mock("../src/routes/admin/usage-backfill.js", () => ({
  backfillHostUsageToOrgDOs: mocks.backfillHostUsageToOrgDOs,
}));

const { ensureLegacyHostUsageBackfilled } = await import(
  "../src/legacy-usage-backfill-gate.js"
);

function envForOrg(orgStub: Record<string, unknown>, hasSandboxHost = true) {
  return {
    ORG: {
      idFromName: (id: string) => id,
      get: () => orgStub,
    },
    SANDBOX_HOST: hasSandboxHost ? ({ fetch: vi.fn() } as unknown as Fetcher) : undefined,
  };
}

describe("ensureLegacyHostUsageBackfilled", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.backfillHostUsageToOrgDOs.mockResolvedValue({
      dry_run: false,
      orgs_scanned: 1,
      legacy_entries_scanned: 0,
      inserted: 0,
      skipped_duplicates: 0,
      errors: [],
      truncated: false,
    });
  });

  it("skips when the legacy sandbox host binding is not configured", async () => {
    const orgStub = {
      claimLegacyHostUsageBackfill: vi.fn(),
      completeLegacyHostUsageBackfill: vi.fn(),
      failLegacyHostUsageBackfill: vi.fn(),
    };

    await ensureLegacyHostUsageBackfilled(envForOrg(orgStub, false) as never, "org_1");

    expect(orgStub.claimLegacyHostUsageBackfill).not.toHaveBeenCalled();
    expect(mocks.backfillHostUsageToOrgDOs).not.toHaveBeenCalled();
  });

  it("claims, backfills, and marks the org complete", async () => {
    const orgStub = {
      claimLegacyHostUsageBackfill: vi.fn(() => "claimed"),
      completeLegacyHostUsageBackfill: vi.fn(),
      failLegacyHostUsageBackfill: vi.fn(),
    };

    await ensureLegacyHostUsageBackfilled(envForOrg(orgStub) as never, "org_1");

    expect(orgStub.claimLegacyHostUsageBackfill).toHaveBeenCalledTimes(1);
    expect(mocks.backfillHostUsageToOrgDOs).toHaveBeenCalledWith(
      expect.objectContaining({ ORG: expect.any(Object), SANDBOX_HOST: expect.any(Object) }),
      { orgIds: ["org_1"] },
    );
    expect(orgStub.completeLegacyHostUsageBackfill).toHaveBeenCalledWith(
      expect.objectContaining({ orgs_scanned: 1 }),
    );
    expect(orgStub.failLegacyHostUsageBackfill).not.toHaveBeenCalled();
  });

  it("blocks credit enforcement while another backfill is running", async () => {
    const orgStub = {
      claimLegacyHostUsageBackfill: vi.fn(() => "running"),
      completeLegacyHostUsageBackfill: vi.fn(),
      failLegacyHostUsageBackfill: vi.fn(),
    };

    await expect(
      ensureLegacyHostUsageBackfilled(envForOrg(orgStub) as never, "org_1"),
    ).rejects.toThrow("Hosted usage migration is already running");

    expect(mocks.backfillHostUsageToOrgDOs).not.toHaveBeenCalled();
  });

  it("marks the org backfill as failed when migration fails", async () => {
    const orgStub = {
      claimLegacyHostUsageBackfill: vi.fn(() => "claimed"),
      completeLegacyHostUsageBackfill: vi.fn(),
      failLegacyHostUsageBackfill: vi.fn(),
    };
    mocks.backfillHostUsageToOrgDOs.mockRejectedValue(new Error("host down"));

    await expect(
      ensureLegacyHostUsageBackfilled(envForOrg(orgStub) as never, "org_1"),
    ).rejects.toThrow("Hosted usage migration failed before credit enforcement: host down");

    expect(orgStub.completeLegacyHostUsageBackfill).not.toHaveBeenCalled();
    expect(orgStub.failLegacyHostUsageBackfill).toHaveBeenCalledWith("host down");
  });
});
