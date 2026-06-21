# Patched Cloudflare Containers egress interceptor for local agent evals.
# Wraps the pinned cloudflare/proxy-everything sidecar with a bridge-bypass entrypoint that works
# around cloudflare/workerd#6793 (sidecar TPROXY rules intercept docker bridge control traffic ->
# container readiness timeout). Built by scripts/run-eval-suite.sh and selected via
# MINIFLARE_CONTAINER_EGRESS_IMAGE. Keep the base pin in sync with the sidecar workerd pulls
# (see scripts/run-eval-suite.sh / workerd's containers-shared default). Remove once #6794 ships.
FROM cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8
COPY --chmod=0755 bypass-entrypoint.sh /bypass-entrypoint.sh
ENTRYPOINT ["/bypass-entrypoint.sh"]
