import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import type { Env } from "../src/types";

const testEnv = env as unknown as Env;
const testEmail = (label: string) =>
  `signup-${label}-${crypto.randomUUID()}@example.com`;

function signupInput(email: string, attemptId = crypto.randomUUID()) {
  return {
    attemptId,
    email,
    password: "password123",
    name: "Signup User",
    signupIp: "203.0.113.10",
  };
}

function signupStub(email: string) {
  const normalizedEmail = email.toLowerCase();
  return testEnv.SIGNUP.get(testEnv.SIGNUP.idFromName(normalizedEmail));
}

describe("SignupDO", () => {
  it("creates one complete user, org, and workspace", async () => {
    const email = testEmail("complete");
    const result = await signupStub(email).completePasswordSignup(
      signupInput(email),
    );

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    expect(await testEnv.EMAIL_TO_USER.get(`email:${email}`)).toBe(
      result.userId,
    );
    const userStub = testEnv.USER.get(testEnv.USER.idFromName(result.userId));
    expect(await userStub.getOrgs()).toEqual([
      expect.objectContaining({
        org_id: result.orgId,
        last_workspace_id: result.workspaceId,
      }),
    ]);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(result.orgId));
    expect(await orgStub.getWorkspaces()).toEqual([
      expect.objectContaining({ id: result.workspaceId }),
    ]);
  });

  it("replays the same attempt without creating duplicate resources", async () => {
    const email = testEmail("retry");
    const input = signupInput(email);
    const stub = signupStub(email);

    const first = await stub.completePasswordSignup(input);
    const retry = await stub.completePasswordSignup(input);

    expect(retry).toEqual(first);
    expect(first.status).toBe("ready");
    if (first.status !== "ready") return;

    const userStub = testEnv.USER.get(testEnv.USER.idFromName(first.userId));
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(first.orgId));
    expect(await userStub.getOrgs()).toHaveLength(1);
    expect(await orgStub.getWorkspaces()).toHaveLength(1);
  });

  it("keeps initial membership idempotent when provisioning is replayed", async () => {
    const email = testEmail("membership-retry");
    const input = signupInput(email);
    const stub = signupStub(email);

    const first = await stub.completePasswordSignup(input);
    const retry = await stub.completePasswordSignup(input);

    expect(first.status).toBe("ready");
    expect(retry).toEqual(first);
    if (first.status !== "ready") return;

    const userStub = testEnv.USER.get(testEnv.USER.idFromName(first.userId));
    expect(await userStub.getOrgs()).toEqual([
      expect.objectContaining({
        org_id: first.orgId,
        role: "owner",
        last_workspace_id: first.workspaceId,
      }),
    ]);
  });

  it("rejects a different attempt after an email has been claimed", async () => {
    const email = testEmail("claimed");
    const stub = signupStub(email);

    await expect(
      stub.completePasswordSignup(signupInput(email, "attempt-one")),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(
      stub.completePasswordSignup(signupInput(email, "attempt-two")),
    ).resolves.toEqual({ status: "exists" });
  });

  it("serializes concurrent attempts for the same email", async () => {
    const email = testEmail("concurrent");
    const stub = signupStub(email);

    const results = await Promise.all([
      stub.completePasswordSignup(signupInput(email, "concurrent-one")),
      stub.completePasswordSignup(signupInput(email, "concurrent-two")),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual([
      "exists",
      "ready",
    ]);
    const ready = results.find((result) => result.status === "ready");
    expect(ready?.status).toBe("ready");
    if (!ready || ready.status !== "ready") return;
    const userStub = testEnv.USER.get(testEnv.USER.idFromName(ready.userId));
    expect(await userStub.getOrgs()).toHaveLength(1);
  });

  it("treats every pre-existing email mapping as an existing account", async () => {
    const email = testEmail("existing-mapping");
    const userId = crypto.randomUUID();
    await testEnv.EMAIL_TO_USER.put(`email:${email}`, userId);

    await expect(
      signupStub(email).completePasswordSignup(signupInput(email)),
    ).resolves.toEqual({ status: "exists" });
  });
});
