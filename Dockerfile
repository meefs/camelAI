FROM node:22-slim

# Version: 2026-01-11-v1
# Slim container with Node, Bun, Python for Claude SDK sandbox

EXPOSE 8080 9000
ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Create claude user (separate from node user)
RUN useradd -m -s /bin/bash claude

# Layer 2: System deps + Bun + Wrangler (changes rarely)
# The globally installed wrangler is wrapped to auto-add --dispatch-namespace.
# Users must use this global wrangler (not npx or local installs).
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    zstd \
    unzip \
    git \
    jq \
    python3 \
    python3-pip \
    fuse \
    libfuse2 \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun wrangler@4.55.0 shadcn \
  && mv /usr/local/bin/wrangler /usr/local/bin/wrangler-real \
  && curl -L -o /usr/local/bin/goofys https://github.com/kahing/goofys/releases/download/v0.24.0/goofys \
  && chmod +x /usr/local/bin/goofys

# Layer 3: Dependencies only - cached unless package.json changes
WORKDIR /app
COPY sandbox/package.json ./
RUN bun install

# Layer 4: App code (changes frequently) - copied after install for better caching
COPY --chmod=755 sandbox/entrypoint.sh ./
COPY sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs ./
COPY sandbox/skills ./skills
RUN chmod -R a+rX /app

# Layer 5: Wrangler wrapper (intercepts deploy to add --dispatch-namespace)
COPY --chmod=755 sandbox/wrangler-wrapper.sh /usr/local/bin/wrangler

# Layer 6: deploy-worker CLI (explicit dispatch namespace deploy, avoids PATH issues)
COPY --chmod=755 sandbox/deploy-worker.sh /usr/local/bin/deploy-worker

# Layer 7: create-worker CLI (scaffolds projects from templates)
RUN ln -s /app/skills/deploy-software/scripts/create-worker.mjs /usr/local/bin/create-worker

# Layer 8: Alias npm to bun for faster package operations
# Bun is npm-compatible and already used for dependencies in this container
RUN ln -sf $(which bun) /usr/local/bin/npm

WORKDIR /home/claude
ENTRYPOINT ["/app/entrypoint.sh"]
