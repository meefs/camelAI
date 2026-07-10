# db-query sandbox container (DbQuerySandbox) — trusted query-execution
# runtime with static-IP database egress.
#
# Runs NO user code. It also does NOT bake the query logic: the runner
# (db-query-sandbox-assets/runner/db-query-runner.mjs) is shipped from the
# worker per call by piping it into node over stdin in a single stateless exec
# (see db-query-service.ts), so changing how we query/export needs only a
# worker deploy, never an image rebuild.
# This image carries only the moving-rarely pieces: the node runtime, the DB
# drivers, and cloudflared. Design doc: docs/db-egress-relay.md.
#
# Tag MUST match the @cloudflare/sandbox npm version (0.12.0). Do NOT set
# ENTRYPOINT — the base image's entrypoint starts the sandbox HTTP API server;
# we only add cloudflared and the baked drivers on top (nothing secret is baked
# in — relay credentials are injected per-run by db-query-service.ts).
ARG SANDBOX_BASE_IMAGE=docker.io/cloudflare/sandbox:0.12.0
FROM ${SANDBOX_BASE_IMAGE}

# --- cloudflared (Access TCP client for the egress relay) --------------------
# Pinned via Cloudflare's apt repo (arch-aware). Bump deliberately; the runner
# only uses `cloudflared access tcp`, a stable long-lived subcommand.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl gnupg; \
    curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg -o /usr/share/keyrings/cloudflare-main.gpg; \
    echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" > /etc/apt/sources.list.d/cloudflared.list; \
    apt-get update; \
    apt-get install -y --no-install-recommends cloudflared=2026.7.1; \
    rm -rf /var/lib/apt/lists/*; \
    cloudflared --version

# --- baked query drivers ------------------------------------------------------
# Only package.json is copied (NOT the runner source): the shipped runner
# resolves `import "pg"` etc. against the node_modules installed here. Wrangler's
# container build context is this Dockerfile's directory (workers/main), so the
# manifest is read from the assets dir. BUILD-FATAL on resolution/network
# failure — never ship a driverless image.
COPY db-query-sandbox-assets/runner/package.json /opt/db-query-runner/package.json
RUN cd /opt/db-query-runner && npm install --omit=dev --no-audit --no-fund \
    && node -e "for (const m of ['pg', 'pg-cursor', 'mysql2', 'tedious', '@dsnp/parquetjs', 'socks']) require.resolve(m); console.log('drivers resolve OK')"
