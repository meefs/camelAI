FROM docker.io/cloudflare/sandbox:0.6.7-python

# Version: 2026-01-02-v2 - migrate to @cloudflare/containers API
# Using sandbox base image for tooling (Bun, Node, etc.)

# Expose container ports
# 8080: WS server for Claude SDK (runs as claude user)
# 9000: Control plane for exec/fs operations (runs as root)
EXPOSE 8080 9000

# R2 sync support (tar+zstd for fast snapshot-based sync)
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/claude
RUN apt-get update && apt-get install -y --no-install-recommends \
    -o Dpkg::Options::="--force-confnew" \
    ca-certificates \
    curl \
    tar \
    zstd \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g wrangler@4.55.0 \
  && mv /usr/local/bin/wrangler /usr/local/bin/wrangler-real

# Wrangler wrapper to ensure WFP dispatch namespace is used
COPY sandbox/wrangler-wrapper.sh /usr/local/bin/wrangler
RUN chmod a+rx /usr/local/bin/wrangler

# Copy and install Claude SDK + control plane + WS server
COPY sandbox/package.json sandbox/driver.mjs sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs sandbox/entrypoint.sh sandbox/run-driver.sh /app/
COPY sandbox/starter-worker /app/starter-worker
WORKDIR /app
RUN bun install
RUN chmod +x /app/entrypoint.sh /app/run-driver.sh && chmod -R a+rX /app

# Create non-root user for Claude agent (ws-server drops privileges to this user)
RUN if ! id -u claude >/dev/null 2>&1; then useradd -m -s /bin/bash -u 1000 claude; fi && \
    chown -R claude:claude /home/claude

WORKDIR /home/claude
