FROM node:22-slim

# Version: 2026-02-02-v66-yarn-pnp-juicefs-cache
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
  && corepack enable \
  && corepack prepare yarn@stable --activate \
  && npm install -g shadcn wrangler \
  && curl -LsSf https://astral.sh/uv/install.sh | env INSTALLER_NO_MODIFY_PATH=1 UV_INSTALL_DIR=/usr/local/bin sh \
  && curl -L -o /usr/local/bin/goofys https://github.com/kahing/goofys/releases/download/v0.24.0/goofys \
  && chmod +x /usr/local/bin/goofys \
  && curl -fsSL https://d.juicefs.com/install | sh - \
  && curl -fsSL -o /tmp/litestream.deb https://github.com/benbjohnson/litestream/releases/download/v0.5.2/litestream-0.5.2-linux-x86_64.deb \
  && dpkg -i /tmp/litestream.deb \
  && rm /tmp/litestream.deb

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

# Layer 5: Template files (Yarn PnP - global cache on JuiceFS)
# Templates use Yarn PnP with global cache at ~/.yarn-cache (persisted on JuiceFS)
COPY --chmod=755 sandbox/skills/deploy-software/templates ./skills/deploy-software/templates

# Layer 6: App code (changes frequently)
COPY --chmod=755 sandbox/entrypoint.sh ./
COPY --chmod=755 sandbox/ws-server.mjs sandbox/sync.mjs sandbox/control-plane.mjs ./
COPY --chmod=755 sandbox/skills/deploy-software/scripts ./skills/deploy-software/scripts
COPY --chmod=644 sandbox/skills/deploy-software/SKILL.md sandbox/skills/deploy-software/AI-APPS.md ./skills/deploy-software/

# Install skills to /etc/claude-code/skills (system-level, no per-container copy needed)
RUN mkdir -p /etc/claude-code/skills/deploy-software \
             /etc/claude-code/skills/file-sharing \
             /etc/claude-code/skills/frontend-design
COPY --chmod=644 sandbox/skills/deploy-software/SKILL.md sandbox/skills/deploy-software/AI-APPS.md /etc/claude-code/skills/deploy-software/
COPY --chmod=644 sandbox/skills/file-sharing/SKILL.md /etc/claude-code/skills/file-sharing/
COPY --chmod=644 sandbox/skills/frontend-design/SKILL.md /etc/claude-code/skills/frontend-design/
RUN chmod -R 755 /etc/claude-code && chown -R root:root /etc/claude-code

# Layer 7: CLI tools (scaffolds projects from templates)
RUN ln -s /app/skills/deploy-software/scripts/create-worker.mjs /usr/local/bin/create-worker

WORKDIR /home/claude
ENTRYPOINT ["/app/entrypoint.sh"]
