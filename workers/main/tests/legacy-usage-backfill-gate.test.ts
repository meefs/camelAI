import { describe, expect, it, vi } from "vitest";

const { ensureLegacyHostUsageBackfilled } = await import(
  "../src/legacy-usage-backfill-gate.js"
);

describe("ensureLegacyHostUsageBackfilled", () => {
  it("skips the legacy hosted usage backfill", async () => {
    const orgStub = {
      claimLegacyHostUsageBackfill: vi.fn(),
      completeLegacyHostUsageBackfill: vi.fn(),
      failLegacyHostUsageBackfill: vi.fn(),
    };
    const env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      SANDBOX_HOST: { fetch: vi.fn() } as unknown as Fetcher,
    };

    await ensureLegacyHostUsageBackfilled(env as never, "org_1");

    expect(env.ORG.idFromName).not.toHaveBeenCalled();
    expect(env.ORG.get).not.toHaveBeenCalled();
    expect(orgStub.claimLegacyHostUsageBackfill).not.toHaveBeenCalled();
    expect(orgStub.completeLegacyHostUsageBackfill).not.toHaveBeenCalled();
    expect(orgStub.failLegacyHostUsageBackfill).not.toHaveBeenCalled();
  });
});
