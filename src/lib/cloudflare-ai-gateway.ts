export const DEFAULT_CLOUDFLARE_AI_GATEWAY_ORIGIN =
  "https://gateway.ai.cloudflare.com";

export interface CloudflareGatewayOriginEnv {
  CF_GATEWAY_BASE_URL?: string;
  TEST_LLM_REPLAY_URL?: string;
}

export function resolveCloudflareGatewayOrigin(
  env: CloudflareGatewayOriginEnv,
): string {
  // E2E determinism: route gateway traffic to the local record/replay stub.
  // Unlike CF_GATEWAY_BASE_URL below, the stub is plain http on localhost, so
  // we return it as-is (no http->https rewrite). Unset in production -> no-op.
  const replay = env.TEST_LLM_REPLAY_URL?.trim().replace(/\/+$/, "");
  if (replay) return replay;
  const override = env.CF_GATEWAY_BASE_URL?.trim().replace(/\/+$/, "");
  if (!override) return DEFAULT_CLOUDFLARE_AI_GATEWAY_ORIGIN;
  // Local dev proxies often redirect http -> https and drop POST bodies on redirect.
  if (override.startsWith("http://")) {
    return `https://${override.slice("http://".length)}`;
  }
  return override;
}

export function buildCloudflareGatewayUrl(
  env: CloudflareGatewayOriginEnv,
  pathSuffix: string,
): string {
  const suffix = pathSuffix.startsWith("/") ? pathSuffix : `/${pathSuffix}`;
  return `${resolveCloudflareGatewayOrigin(env)}${suffix}`;
}
