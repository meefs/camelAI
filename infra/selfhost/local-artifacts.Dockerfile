FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY scripts/local-artifacts-server.mjs /app/scripts/local-artifacts-server.mjs

EXPOSE 7001
CMD ["node", "/app/scripts/local-artifacts-server.mjs"]
