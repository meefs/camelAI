const stockEgressImage =
  "cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8";
const localOnlyEgressImages = new Set([
  "camelai-eval-egress-fixed",
  "camelai-eval-egress-fixed:latest",
]);

export function applyCloudflareContainerEgressWorkaround(env = process.env) {
  if (
    env.MINIFLARE_CONTAINER_EGRESS_IMAGE &&
    !localOnlyEgressImages.has(env.MINIFLARE_CONTAINER_EGRESS_IMAGE)
  ) {
    return;
  }

  // Wrangler/Miniflare unconditionally pulls the configured egress interceptor
  // as linux/amd64, so a local-only tag such as camelai-eval-egress-fixed:latest
  // makes local dev fail before containers start. Keep normal dev on the same
  // pullable pinned image that Miniflare uses by default.
  env.MINIFLARE_CONTAINER_EGRESS_IMAGE = stockEgressImage;
}
