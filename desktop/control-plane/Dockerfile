FROM node:22-bookworm-slim

ENV HOME=/mnt/camelai-shared/runtime/container-home
ENV CLAUDE_CONFIG_DIR=/mnt/camelai-shared/runtime/container-home/.claude
ENV DESKTOP_RUNTIME_CONTROL_PLANE_PORT=4317

WORKDIR /opt/camelai-desktop-guest

RUN apt-get update \
 && apt-get install -y --no-install-recommends gosu \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY control-plane.mjs ./
COPY entrypoint.sh /usr/local/bin/camelai-desktop-entrypoint

RUN chmod 0755 /usr/local/bin/camelai-desktop-entrypoint

ENTRYPOINT ["/usr/local/bin/camelai-desktop-entrypoint"]
