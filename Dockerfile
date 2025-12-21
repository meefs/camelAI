FROM docker.io/cloudflare/sandbox:0.6.6

# Must match the @cloudflare/sandbox npm package version.

# Optional: app ports you plan to expose via the Sandbox API (control plane uses 3000)
EXPOSE 8080

# R2 sync support (rclone for downloading/uploading on init/shutdown)
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/claude
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends \
    -o Dpkg::Options::="--force-confnew" \
    ca-certificates \
    curl \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g wrangler@4.55.0 \
  && case "${TARGETARCH}" in \
    amd64) RCLONE_ARCH="amd64" ;; \
    arm64) RCLONE_ARCH="arm64" ;; \
    *) echo "Unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
  esac \
  && curl -L -o /tmp/rclone.zip "https://downloads.rclone.org/v1.68.2/rclone-v1.68.2-linux-${RCLONE_ARCH}.zip" \
  && unzip /tmp/rclone.zip -d /tmp \
  && mv "/tmp/rclone-v1.68.2-linux-${RCLONE_ARCH}/rclone" /usr/local/bin/ \
  && chmod +x /usr/local/bin/rclone \
  && rm -rf /tmp/rclone*

# Copy and install Claude SDK driver + integration proxy
COPY sandbox/package.json sandbox/driver.mjs sandbox/proxy.mjs sandbox/run-driver.sh /app/
COPY sandbox/starter-worker /app/starter-worker
WORKDIR /app
RUN bun install
RUN chmod +x /app/run-driver.sh && chmod -R a+rX /app

# Create non-root user for running the Claude agent
RUN if ! id -u claude >/dev/null 2>&1; then useradd -m -s /bin/bash -u 1000 claude; fi && \
    chown -R claude:claude /home/claude

USER claude
WORKDIR /home/claude
