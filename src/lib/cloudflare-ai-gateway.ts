export const DEFAULT_CLOUDFLARE_AI_GATEWAY_ORIGIN =
  "https://gateway.ai.cloudflare.com";

export interface CloudflareGatewayOriginEnv {
  CF_GATEWAY_BASE_URL?: string;
}

export function resolveCloudflareGatewayOrigin(
  env: CloudflareGatewayOriginEnv,
): string {
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
