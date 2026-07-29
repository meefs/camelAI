import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      remoteBindings: false,
      wrangler: { configPath: "./workers/discord-bridge/wrangler.jsonc" },
      miniflare: {
        compatibilityDate: "2026-06-10",
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          DISCORD_BOT_TOKEN: "test-discord-token",
          DISCORD_APPLICATION_ID: "123456789012345678",
          DISCORD_MESSAGE_CONTENT_MODE: "full",
          DISCORD_INGRESS_ENABLED: "true",
          DISCORD_OUTBOUND_ENABLED: "true",
        },
        durableObjectsPersist: false,
        cachePersist: false,
        d1Persist: false,
        kvPersist: false,
        r2Persist: false,
      },
    }),
  ],
  test: {
    include: ["workers/discord-bridge/tests/**/*.test.ts"],
    testTimeout: 20_000,
  },
});
