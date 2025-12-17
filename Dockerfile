FROM docker.io/cloudflare/sandbox:0.6.6

# Required during local development to access exposed ports
EXPOSE 8080

# R2 sync support (rclone for downloading/uploading on init/shutdown)
ENV DEBIAN_FRONTEND=noninteractive
ENV HOME=/home/claude
RUN apt-get update && apt-get install -y --no-install-recommends \
    -o Dpkg::Options::="--force-confnew" \
    ca-certificates \
    curl \
    unzip \
  && rm -rf /var/lib/apt/lists/* \
  && curl -L -o /tmp/rclone.zip https://downloads.rclone.org/v1.68.2/rclone-v1.68.2-linux-amd64.zip \
  && unzip /tmp/rclone.zip -d /tmp \
  && mv /tmp/rclone-v1.68.2-linux-amd64/rclone /usr/local/bin/ \
  && chmod +x /usr/local/bin/rclone \
  && rm -rf /tmp/rclone*

# Copy and install Claude SDK driver
COPY sandbox/package.json sandbox/driver.mjs sandbox/run-driver.sh sandbox/entrypoint.sh /app/
WORKDIR /app
RUN bun install
RUN chmod +x /app/run-driver.sh /app/entrypoint.sh && chmod -R a+rX /app

# Create non-root user for running the Claude agent
RUN useradd -m -s /bin/bash -u 1000 claude && \
    chown -R claude:claude /home/claude

USER claude
WORKDIR /home/claude

CMD ["/app/entrypoint.sh"]
