import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

describe("OrgDO OpenAI subscription", () => {
  const testEnv = env as unknown as TestEnv;

  it("stores one shared encrypted subscription for the organization", async () => {
    const email = `org-openai-${crypto.randomUUID()}@example.com`;
    const { userId } = await createUser(testEnv, email, "password123", "Owner");
    const { org } = await createOrg(testEnv, "OpenAI Subscription Org", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    expect(await orgStub.getOpenAiSubscription()).toBeNull();
    await orgStub.setOpenAiSubscription(
      "encrypted-credentials",
      "person@example.com",
      "plus",
    );

    expect(await orgStub.getOpenAiSubscription()).toMatchObject({
      credentials_encrypted: "encrypted-credentials",
      account_email: "person@example.com",
      plan_type: "plus",
    });

    await orgStub.deleteOpenAiSubscription();
    expect(await orgStub.getOpenAiSubscription()).toBeNull();
  });
});
