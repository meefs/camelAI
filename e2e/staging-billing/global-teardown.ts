import { rm } from "node:fs/promises";
import { StagingAdminClient } from "./admin-js-exec-client";
import { fixtureStatePath, readFixtureState } from "./fixture-state";

export default async function globalTeardown(): Promise<void> {
  let state;
  try {
    state = await readFixtureState();
  } catch {
    return;
  }

  const admin = new StagingAdminClient();
  const cleanupFailures: string[] = [];
  for (const actor of [state.primary, state.payg]) {
    let cleanupError: unknown = null;
    for (const retryDelayMs of [0, 1_000, 2_000, 4_000, 8_000]) {
      if (retryDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
      }
      try {
        // A just-completed Stripe test flow can deliver its final webhook after
        // the first deletion and briefly project the ids back into OrgDO. Both
        // controls are idempotent, so retry the pair until that queue settles.
        await admin.deleteTestCustomer(actor.orgId);
        await admin.deleteActor(actor.userId);
        cleanupError = null;
        break;
      } catch (error) {
        cleanupError = error;
      }
    }
    if (cleanupError) {
      cleanupFailures.push(
        `Fixture cleanup (${actor.orgId}/${actor.userId}): ${String(cleanupError)}`,
      );
    }
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      `Staging fixture cleanup was incomplete; fixture ids remain at ${fixtureStatePath}:\n${cleanupFailures.join("\n")}`,
    );
  }

  await rm(fixtureStatePath, { force: true });
}
