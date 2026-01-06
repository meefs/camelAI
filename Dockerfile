FROM node:22-slim

# Version: 2026-01-06-v1
# Slim container with Node, Bun, Python for Claude SDK sandbox

EXPOSE 8080 9000
ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Create claude user (separate from node user)
RUN useradd -m -s /bin/bash claude

# Layer 2: System deps + Bun + Wrangler (changes rarely)
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
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun wrangler@4.55.0 shadcn \
  && mv /usr/local/bin/wrangler /usr/local/bin/wrangler-real

# Layer 3: Wrangler wrapper (changes rarely)
COPY --chmod=755 sandbox/wrangler-wrapper.sh /usr/local/bin/wrangler

# Layer 4: Dependencies only - cached unless package.json changes
WORKDIR /app
COPY sandbox/package.json ./
RUN bun install

# Layer 5: App code (changes frequently) - copied after install for better caching
COPY --chmod=755 sandbox/entrypoint.sh ./
COPY sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs ./
COPY sandbox/starter-worker ./starter-worker
COPY sandbox/skills ./skills
RUN chmod -R a+rX /app

WORKDIR /home/claude
ENTRYPOINT ["/app/entrypoint.sh"]
