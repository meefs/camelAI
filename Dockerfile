FROM node:22-slim

# Version: 2026-02-04-v78-vite-daemon
# Slim container with Node, Yarn PnP, Python for Claude SDK sandbox

EXPOSE 8080 9000
ENV DEBIAN_FRONTEND=noninteractive

# Layer 1: Create claude user (separate from node user)
RUN useradd -m -s /bin/bash claude

# Pre-create integration env file with correct permissions
# This file is written by ws-server (runs as claude) when integrations are pushed
RUN touch /etc/profile.d/chiridion-integrations.sh \
  && chown claude:claude /etc/profile.d/chiridion-integrations.sh \
  && chmod 644 /etc/profile.d/chiridion-integrations.sh

# Layer 2: System deps + JuiceFS
# Note: fuse3 replaces fuse (they conflict). libfuse2 provides compat for older tools.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    tar \
    bzip2 \
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
    imagemagick \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare yarn@4.9.2 --activate \
  && npm install -g shadcn wrangler \
  && curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 UV_INSTALL_DIR=/usr/local/bin sh \
  && curl -L -o /usr/local/bin/goofys https://github.com/kahing/goofys/releases/download/v0.24.0/goofys \
  && chmod +x /usr/local/bin/goofys \
  && curl -fsSL https://d.juicefs.com/install | sh - \
  && curl -fsSL -o /tmp/litestream.deb https://github.com/benbjohnson/litestream/releases/download/v0.5.2/litestream-0.5.2-linux-x86_64.deb \
  && dpkg -i /tmp/litestream.deb \
  && rm /tmp/litestream.deb \
  && curl -fsSL https://github.com/xo/usql/releases/download/v0.19.14/usql_static-0.19.14-linux-amd64.tar.bz2 | tar -xj -C /usr/local/bin usql_static \
  && mv /usr/local/bin/usql_static /usr/local/bin/usql

# Layer 3: Sandbox dependencies - cached unless package.json changes
WORKDIR /app
COPY sandbox/package.json ./
RUN npm install

# Layer 4: Python data analysis packages - cached unless requirements.txt changes
# Install with uv for speed, using system Python (--system flag)
# These are pre-installed so users have immediate access to data analysis tools
COPY sandbox/requirements.txt ./
# Debian marks /usr as externally managed (PEP 668); allow system installs for baked-in tools.
RUN PIP_BREAK_SYSTEM_PACKAGES=1 uv pip install --system --break-system-packages -r requirements.txt

# Layer 5: Template files (Yarn PnP with project-local .yarn/cache on JuiceFS)
# Templates use Yarn PnP with local cache in each template directory (.yarn/cache)
COPY --chmod=755 sandbox/skills/developing-software/templates ./skills/developing-software/templates

# Layer 6: App code (changes frequently)
COPY --chmod=755 sandbox/entrypoint.sh ./
COPY --chmod=755 sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs sandbox/memory-logger.mjs sandbox/vite-build.mjs sandbox/vite-daemon.mjs ./
COPY --chmod=755 sandbox/session-search ./session-search
COPY --chmod=755 sandbox/skills/developing-software/scripts ./skills/developing-software/scripts
COPY --chmod=644 sandbox/skills/developing-software/SKILL.md sandbox/skills/developing-software/AI-APPS.md ./skills/developing-software/

# Install skills to /etc/claude-code/skills (system-level, no per-container copy needed)
RUN mkdir -p /etc/claude-code/skills/developing-software \
             /etc/claude-code/skills/file-sharing \
             /etc/claude-code/skills/data-analysis
COPY --chmod=644 sandbox/skills/developing-software/SKILL.md sandbox/skills/developing-software/AI-APPS.md /etc/claude-code/skills/developing-software/
COPY --chmod=644 sandbox/skills/file-sharing/SKILL.md /etc/claude-code/skills/file-sharing/
COPY --chmod=644 sandbox/skills/data-analysis/SKILL.md /etc/claude-code/skills/data-analysis/
RUN chmod -R 755 /etc/claude-code && chown -R root:root /etc/claude-code

# Layer 7: CLI tools (scaffolds projects from templates)
RUN ln -s /app/skills/developing-software/scripts/create-worker.mjs /usr/local/bin/create-worker \
  && ln -s /app/session-search/src/cli.mjs /usr/local/bin/session-search

WORKDIR /home/claude
ENTRYPOINT ["/app/entrypoint.sh"]
