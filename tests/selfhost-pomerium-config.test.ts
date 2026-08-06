import { describe, expect, it } from "vitest";

import { requiredHttpsUrlWithOptionalPath } from "../scripts/selfhost-pomerium-config.mjs";

describe("self-host Pomerium configuration", () => {
  it("accepts path-based OIDC issuer URLs", () => {
    expect(
      requiredHttpsUrlWithOptionalPath(
        "https://idp.example.com/application/o/camelai/",
        "POMERIUM_IDP_PROVIDER_URL",
      ).href,
    ).toBe("https://idp.example.com/application/o/camelai/");
  });

  it.each([
    "http://idp.example.com/application/o/camelai/",
    "https://idp.example.com/application/o/camelai/?tenant=example",
    "https://idp.example.com/application/o/camelai/#issuer",
  ])("rejects unsafe OIDC issuer URL %s", (url) => {
    expect(() =>
      requiredHttpsUrlWithOptionalPath(url, "POMERIUM_IDP_PROVIDER_URL"),
    ).toThrow(
      "POMERIUM_IDP_PROVIDER_URL must be an https URL without a query or fragment",
    );
  });
});
