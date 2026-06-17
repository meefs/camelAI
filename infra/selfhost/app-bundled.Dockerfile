FROM node:22-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g bun@1.3.4

WORKDIR /workspace

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 3001
CMD ["sh", "-lc", "bun run selfhost:workerd:build && SELFHOST_WORKERD_SOCKET=0.0.0.0:3001 bun run selfhost:workerd:serve"]
