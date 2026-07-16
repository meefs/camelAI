import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { StagingAdminClient } from "./admin-js-exec-client";
import { fixtureStatePath, type ActorFixture } from "./fixture-state";

function fixtureIdentity(label: string): { email: string; password: string; name: string } {
  const run = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const domain = process.env.STAGING_BILLING_EMAIL_DOMAIN || "e2e.camelai.dev";
  return {
    email: `staging-billing-${label}-${run}@${domain}`,
    password: `E2e-${randomBytes(18).toString("base64url")}!9a`,
    name: `Staging Billing ${label}`,
  };
}

export default async function globalSetup(): Promise<void> {
  if (process.env.STAGING_BILLING_E2E !== "1") {
    throw new Error(
      "This suite mutates staging. Run it through `bun run test:e2e:staging-billing`.",
    );
  }

  const admin = new StagingAdminClient();
  await admin.preflight();

  const created: ActorFixture[] = [];
  try {
    for (const label of ["primary", "payg"] as const) {
      const identity = fixtureIdentity(label);
      const actor = await admin.createActor(identity);
      created.push({ ...actor, password: identity.password });
    }
  } catch (error) {
    for (const actor of created) {
      await admin.deleteActor(actor.userId).catch(() => undefined);
    }
    throw error;
  }

  await mkdir(path.dirname(fixtureStatePath), { recursive: true });
  await writeFile(
    fixtureStatePath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        primary: created[0],
        payg: created[1],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
