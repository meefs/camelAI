import { describe, expect, it } from "vitest";
import {
  EMPTY_BYOK_CREDENTIAL,
  resolveOrgScopedByokApiKey,
} from "@/lib/byok-credential-state";

describe("org-scoped BYOK credentials", () => {
  it("never exposes a credential to a different organization", () => {
    const credential = { orgId: "org_a", apiKey: "secret-for-a" };

    expect(resolveOrgScopedByokApiKey(credential, "org_a")).toBe(
      "secret-for-a",
    );
    expect(resolveOrgScopedByokApiKey(credential, "org_b")).toBe("");
    expect(resolveOrgScopedByokApiKey(credential, null)).toBe("");
  });

  it("uses an empty credential for cleared form state", () => {
    expect(resolveOrgScopedByokApiKey(EMPTY_BYOK_CREDENTIAL, "org_a")).toBe(
      "",
    );
  });
});
