import { describe, expect, it } from "vitest";
import {
  buildCloudflareGatewayUrl,
  DEFAULT_CLOUDFLARE_AI_GATEWAY_ORIGIN,
  resolveCloudflareGatewayOrigin,
} from "@/lib/cloudflare-ai-gateway";

describe("cloudflare-ai-gateway", () => {
  it("uses the default Cloudflare gateway origin when no override is set", () => {
    expect(resolveCloudflareGatewayOrigin({})).toBe(
      DEFAULT_CLOUDFLARE_AI_GATEWAY_ORIGIN,
    );
  });

  it("uses CF_GATEWAY_BASE_URL for local dev gateway proxies", () => {
    expect(
      resolveCloudflareGatewayOrigin({
        CF_GATEWAY_BASE_URL: "http://cloudflare-ai-gateway.internal.example/",
      }),
    ).toBe("https://cloudflare-ai-gateway.internal.example");

    expect(
      buildCloudflareGatewayUrl(
        { CF_GATEWAY_BASE_URL: "http://cloudflare-ai-gateway.internal.example" },
        "/v1/acct/gw/openai/chat/completions",
      ),
    ).toBe(
      "https://cloudflare-ai-gateway.internal.example/v1/acct/gw/openai/chat/completions",
    );
  });
});
