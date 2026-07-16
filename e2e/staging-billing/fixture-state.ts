import { readFile } from "node:fs/promises";
import path from "node:path";
import type { StagingActor } from "./admin-js-exec-client";

export interface ActorFixture extends StagingActor {
  password: string;
}

export interface StagingBillingFixtureState {
  createdAt: string;
  primary: ActorFixture;
  payg: ActorFixture;
}

export const fixtureStatePath = path.resolve(
  process.env.STAGING_BILLING_STATE_FILE ||
    "test-results/staging-billing/fixture-state.json",
);

export async function readFixtureState(): Promise<StagingBillingFixtureState> {
  return JSON.parse(await readFile(fixtureStatePath, "utf8")) as StagingBillingFixtureState;
}

