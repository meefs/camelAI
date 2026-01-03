FROM node:22-slim

# Version: 2026-01-03-v8
# Slim container with Node, Bun, Python for Claude SDK sandbox

EXPOSE 8080 9000
ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Create claude user first (rename node user which has UID 1000)
RUN usermod -l claude -d /home/claude node \
  && groupmod -n claude node \
  && mv /home/node /home/claude \
  && chown -R claude:claude /home/claude

# Layer 2: System deps + Bun + Wrangler (changes rarely)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    zstd \
    unzip \
    git \
    python3 \
    python3-pip \
  && rm -rf /var/lib/apt/lists/* \
  && BUN_INSTALL=/usr/local curl -fsSL https://bun.sh/install | bash \
  && npm install -g wrangler@4.55.0 \
  && mv /usr/local/bin/wrangler /usr/local/bin/wrangler-real

# Layer 3: Wrangler wrapper (changes rarely)
COPY --chmod=755 sandbox/wrangler-wrapper.sh /usr/local/bin/wrangler

# Layer 4: Dependencies only - cached unless package.json changes
WORKDIR /app
COPY sandbox/package.json ./
RUN bun install

# Layer 5: App code (changes frequently) - copied after install for better caching
COPY --chmod=755 sandbox/entrypoint.sh sandbox/run-driver.sh ./
COPY sandbox/driver.mjs sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs ./
COPY sandbox/starter-worker ./starter-worker
RUN chmod -R a+rX /app

WORKDIR /home/claude
ENTRYPOINT ["/app/entrypoint.sh"]
