FROM node:22-slim

# Version: 2026-01-30-v49-add-data-analysis-tools
# Slim container with Node, Bun, Python for Claude SDK sandbox

EXPOSE 8080 9000 4873
ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Create claude user (separate from node user)
RUN useradd -m -s /bin/bash claude

# Pre-create integration env file with correct permissions
# This file is written by ws-server (runs as claude) when integrations are pushed
RUN touch /etc/profile.d/chiridion-integrations.sh \
  && chown claude:claude /etc/profile.d/chiridion-integrations.sh \
  && chmod 644 /etc/profile.d/chiridion-integrations.sh

# Layer 2: System deps + Bun + Verdaccio + JuiceFS
# Note: fuse3 replaces fuse (they conflict). libfuse2 provides compat for older tools.
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
    fuse3 \
    libfuse2 \
    libfuse3-3 \
    sqlite3 \
    strace \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun shadcn verdaccio pm2 \
  && curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 UV_INSTALL_DIR=/usr/local/bin sh \
  && curl -L -o /usr/local/bin/goofys https://github.com/kahing/goofys/releases/download/v0.24.0/goofys \
  && chmod +x /usr/local/bin/goofys \
  && curl -fsSL https://d.juicefs.com/install | sh - \
  && curl -fsSL -o /tmp/litestream.deb https://github.com/benbjohnson/litestream/releases/download/v0.5.2/litestream-0.5.2-linux-x86_64.deb \
  && dpkg -i /tmp/litestream.deb \
  && rm /tmp/litestream.deb

# Layer 3: Chiridion Wrangler + Verdaccio local registry
# Pre-publish chiridion-wrangler as "wrangler" so all npm/bun installs get our version
WORKDIR /chiridion-wrangler
COPY packages/chiridion-wrangler/package.json ./
COPY packages/chiridion-wrangler/bin ./bin
COPY packages/chiridion-wrangler/verdaccio ./verdaccio
RUN mkdir -p wrangler-dist
COPY packages/chiridion-wrangler/wrangler-dist/cli.js ./wrangler-dist/

# Set up Verdaccio storage and config
RUN mkdir -p /verdaccio/storage /verdaccio/plugins \
  && cp verdaccio/config.yaml /verdaccio/config.yaml \
  && touch /verdaccio/htpasswd

# Install wrangler deps and publish to local registry
RUN npm install --omit=dev \
  && chmod +x bin/wrangler.js verdaccio/publish-wrangler.sh \
  && ln -s /chiridion-wrangler/bin/wrangler.js /usr/local/bin/wrangler

# Start verdaccio temporarily, publish our wrangler package, then stop it
RUN bash -c '\
  verdaccio --config /verdaccio/config.yaml & \
  sleep 2 && \
  ./verdaccio/publish-wrangler.sh && \
  pkill -f verdaccio || true \
'

# Layer 4: Sandbox dependencies - cached unless package.json changes
WORKDIR /app
COPY sandbox/package.json ./
RUN npm install

# Layer 4.5: Python data analysis packages - cached unless requirements.txt changes
# Install with uv for speed, using system Python (--system flag)
# These are pre-installed so users have immediate access to data analysis tools
COPY sandbox/requirements.txt ./
RUN uv pip install --system -r requirements.txt

# Layer 5: Template files + Yarn PnP setup (cached unless template files change)
# Copy ONLY template files first, before frequently-changing sandbox code
# This ensures template yarn install is cached when only ws-server.mjs changes
# Remove npm's yarn classic and install Yarn Berry via corepack
RUN npm uninstall -g yarn 2>/dev/null || true \
  && rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg 2>/dev/null || true \
  && corepack enable \
  && corepack prepare yarn@stable --activate
COPY sandbox/skills/deploy-software/templates ./skills/deploy-software/templates

# Pre-install template dependencies with Yarn PnP (minimal files for fast JuiceFS copy)
# Yarn PnP stores deps as ~400 zip files instead of ~8000 files in node_modules
# YARN_IGNORE_PATH=1 prevents Yarn from detecting parent /app/package.json
# Install template deps in a temp location first (avoids /app workspace detection)
# Then copy PnP files back to template
RUN bash -c '\
  verdaccio --config /verdaccio/config.yaml & \
  sleep 2 && \
  mkdir -p /tmp/template-build && \
  cp -r /app/skills/deploy-software/templates/react-router/* /tmp/template-build/ && \
  cp -r /app/skills/deploy-software/templates/react-router/.* /tmp/template-build/ 2>/dev/null || true && \
  cd /tmp/template-build && \
  echo "Downloading Yarn Berry release..." && \
  mkdir -p .yarn/releases && \
  curl -fsSL -o .yarn/releases/yarn-4.6.0.cjs https://repo.yarnpkg.com/4.6.0/packages/yarnpkg-cli/bin/yarn.js && \
  echo "Installing in isolated /tmp/template-build..." && \
  yarn install 2>&1 && \
  echo "=== Yarn install complete ===" && \
  echo "=== PnP files created ===" && \
  ls -la .pnp.* 2>/dev/null || echo "No PnP files" && \
  echo "=== Copying PnP files and generated types back ===" && \
  cp -r .pnp.* /app/skills/deploy-software/templates/react-router/ 2>/dev/null || true && \
  cp -r .yarn /app/skills/deploy-software/templates/react-router/ 2>/dev/null || true && \
  cp yarn.lock /app/skills/deploy-software/templates/react-router/ 2>/dev/null || true && \
  cp worker-configuration.d.ts /app/skills/deploy-software/templates/react-router/ 2>/dev/null || true && \
  rm -rf /tmp/template-build && \
  kill $(pgrep -f verdaccio) 2>/dev/null || true \
'

# Layer 6: App code (changes frequently) - copied AFTER template install for better caching
# Changes to ws-server.mjs, entrypoint.sh, etc. won't trigger template rebuild
COPY --chmod=755 sandbox/entrypoint.sh ./
COPY sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs ./
COPY sandbox/skills/deploy-software/scripts ./skills/deploy-software/scripts
COPY sandbox/skills/deploy-software/SKILL.md ./skills/deploy-software/
COPY sandbox/skills/file-sharing ./skills/file-sharing
COPY sandbox/skills/frontend-design ./skills/frontend-design
RUN chmod -R a+rX /app

# Layer 7: create-worker CLI (scaffolds projects from templates)
RUN ln -s /app/skills/deploy-software/scripts/create-worker.mjs /usr/local/bin/create-worker

# Layer 8: Configure bun/npm to use local Verdaccio registry
# This ensures all wrangler installs get our chiridion-wrangler
# Must configure for both root (build time) and claude user (runtime)
RUN echo 'registry = "http://localhost:4873"' > /root/.bunfig.toml \
  && cp /root/.bunfig.toml /home/claude/.bunfig.toml \
  && chown claude:claude /home/claude/.bunfig.toml \
  && npm config set registry http://localhost:4873 \
  && echo 'registry=http://localhost:4873' > /home/claude/.npmrc \
  && chown claude:claude /home/claude/.npmrc

WORKDIR /home/claude
ENTRYPOINT ["/app/entrypoint.sh"]
