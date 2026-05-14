import type { Env } from "./types.js";

export async function ensureLegacyHostUsageBackfilled(
  env: Pick<Env, "ORG" | "SANDBOX_HOST">,
  orgId: string,
): Promise<void> {
  void env;
  void orgId;
}
