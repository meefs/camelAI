FROM docker.io/cloudflare/sandbox:0.6.6-python

# Version: 2026-01-01-v9 - run as root, su to claude for ws-server
# Must match the @cloudflare/sandbox npm package version.

# Optional: app ports you plan to expose via the Sandbox API (control plane uses 3000)
# 8080: WS server for Claude SDK
# 8081: Integration proxy for external APIs
EXPOSE 8080 8081

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
  && npm install -g wrangler@4.55.0

# Copy and install Claude SDK driver + integration proxy + WS server
COPY sandbox/package.json sandbox/driver.mjs sandbox/proxy.mjs sandbox/ws-server.mjs sandbox/sync.mjs sandbox/run-driver.sh sandbox/run-ws-server.sh /app/
COPY sandbox/starter-worker /app/starter-worker
WORKDIR /app
RUN bun install
RUN chmod +x /app/run-driver.sh /app/run-ws-server.sh && chmod -R a+rX /app

# Create non-root user for Claude agent (ws-server drops privileges to this user)
RUN if ! id -u claude >/dev/null 2>&1; then useradd -m -s /bin/bash -u 1000 claude; fi && \
    chown -R claude:claude /home/claude

WORKDIR /home/claude
