import type { Env } from "./types.js";
import { backfillHostUsageToOrgDOs } from "./routes/admin/usage-backfill.js";

type LegacyHostUsageBackfillClaim = "claimed" | "complete" | "running";

interface LegacyHostUsageBackfillOrgStub {
  claimLegacyHostUsageBackfill():
    | Promise<LegacyHostUsageBackfillClaim>
    | LegacyHostUsageBackfillClaim;
  completeLegacyHostUsageBackfill(result: unknown): Promise<void> | void;
  failLegacyHostUsageBackfill(error: string): Promise<void> | void;
}

export async function ensureLegacyHostUsageBackfilled(
  env: Pick<Env, "ORG" | "SANDBOX_HOST">,
  orgId: string,
): Promise<void> {
  if (!env.SANDBOX_HOST) return;

  const orgStub = env.ORG.get(
    env.ORG.idFromName(orgId),
  ) as unknown as LegacyHostUsageBackfillOrgStub;
  const claim = await Promise.resolve(orgStub.claimLegacyHostUsageBackfill());
  if (claim === "complete") return;
  if (claim === "running") {
    throw new Error("Hosted usage migration is already running. Try again shortly.");
  }

  try {
    const result = await backfillHostUsageToOrgDOs(env as Env, {
      orgIds: [orgId],
    });
    await Promise.resolve(orgStub.completeLegacyHostUsageBackfill(result));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.resolve(orgStub.failLegacyHostUsageBackfill(message));
    throw new Error(`Hosted usage migration failed before credit enforcement: ${message}`);
  }
}
