import { describe, expect, it, vi } from "vitest";

import {
  runDiscordCanaryBootstrap,
  runDiscordCanaryPreflight,
} from "../scripts/discord-canary.mjs";

const callbackUri =
  "https://dev-illiana.camelai.dev/api/integrations/discord/callback";
const applicationId = "123456789012345678";
const normalQueue = "chiridion-app-discord-events-dev-illiana";
const deadLetterQueue = "chiridion-app-discord-events-dlq-dev-illiana";

function canaryConfigs() {
  return {
    main: {
      vars: {
        DISCORD_CHANNEL_ENABLED: "false",
        DISCORD_CLIENT_ID: applicationId,
      },
      services: [
        {
          binding: "DISCORD_BRIDGE",
          service: "chiridion-discord-bridge-dev-illiana",
        },
      ],
      queues: {
        consumers: [
          {
            queue: normalQueue,
            dead_letter_queue: deadLetterQueue,
          },
          { queue: deadLetterQueue },
        ],
      },
    },
    bridge: {
      env: {
        "dev-illiana": {
          name: "chiridion-discord-bridge-dev-illiana",
          vars: {
            DISCORD_APPLICATION_ID: applicationId,
            DISCORD_INGRESS_ENABLED: "false",
            DISCORD_OUTBOUND_ENABLED: "true",
          },
          queues: {
            producers: [
              {
                binding: "DISCORD_EVENTS_QUEUE",
                queue: normalQueue,
              },
            ],
          },
        },
      },
    },
  };
}

function successJson(value: unknown) {
  return { stdout: JSON.stringify(value), stderr: "" };
}

function commandName(args: string[]) {
  return args.join(" ");
}

describe("Discord canary bootstrap", () => {
  it("creates a first dark bridge deployment before requiring its bot secret", async () => {
    const calls: string[] = [];
    const wrangler = vi.fn(async (args: string[]) => {
      calls.push(commandName(args));
      if (args[0] === "queues" && args[1] === "info") {
        return successJson({});
      }
      if (args[0] === "deployments") {
        return successJson([]);
      }
      if (args[0] === "deploy") {
        return { stdout: "", stderr: "" };
      }
      if (args[0] === "secret") {
        return successJson([]);
      }
      throw new Error(`unexpected wrangler call: ${commandName(args)}`);
    });

    const configs = canaryConfigs();
    await expect(
      runDiscordCanaryBootstrap({
        ...configs,
        envVars: {
          NEXTJS_ENV: "test",
          DISCORD_CANARY_CALLBACK_URI_CONFIRMED: callbackUri,
        },
        wrangler,
        deployMain: vi.fn(),
        pass: vi.fn(),
      }),
    ).rejects.toThrow(
      "bootstrap paused after the first dark bridge deploy; store DISCORD_BOT_TOKEN",
    );

    expect(calls).toContain(
      "deploy -c workers/discord-bridge/wrangler.jsonc --env dev-illiana",
    );
    expect(
      calls.findIndex((call) => call.startsWith("deploy -c workers/discord-bridge")),
    ).toBeLessThan(
      calls.findIndex((call) =>
        call.startsWith(
          "secret list -c workers/discord-bridge/wrangler.jsonc",
        ),
      ),
    );
  });

  it("leaves existing queues and deployments untouched while reporting absent secrets", async () => {
    const calls: string[] = [];
    const wrangler = vi.fn(async (args: string[]) => {
      calls.push(commandName(args));
      if (args[0] === "queues" && args[1] === "info") {
        return successJson({});
      }
      if (args[0] === "deployments") {
        return successJson([{ id: "existing" }]);
      }
      if (
        args[0] === "secret" &&
        args.includes("workers/discord-bridge/wrangler.jsonc")
      ) {
        return successJson([{ name: "DISCORD_BOT_TOKEN" }]);
      }
      if (args[0] === "secret") {
        return successJson([]);
      }
      throw new Error(`unexpected wrangler call: ${commandName(args)}`);
    });

    const configs = canaryConfigs();
    await expect(
      runDiscordCanaryBootstrap({
        ...configs,
        envVars: {
          NEXTJS_ENV: "test",
          DISCORD_CANARY_CALLBACK_URI_CONFIRMED: callbackUri,
        },
        wrangler,
        deployMain: vi.fn(),
        pass: vi.fn(),
      }),
    ).rejects.toThrow(
      "store DISCORD_CLIENT_SECRET and ADMIN_API_KEY",
    );

    expect(calls.some((call) => call.startsWith("queues create"))).toBe(false);
    expect(calls.some((call) => call.startsWith("deploy -c"))).toBe(false);
  });

  it("requires the local admin key before any remote preflight call", async () => {
    const wrangler = vi.fn();
    const fetchImpl = vi.fn();
    const configs = canaryConfigs();

    await expect(
      runDiscordCanaryPreflight({
        ...configs,
        phase: "bridge",
        envVars: {
          NEXTJS_ENV: "test",
          DISCORD_CANARY_CALLBACK_URI_CONFIRMED: callbackUri,
        },
        wrangler,
        fetchImpl,
        pass: vi.fn(),
      }),
    ).rejects.toThrow(
      "DISCORD_CANARY_ADMIN_API_KEY is required for remote bridge health",
    );

    expect(wrangler).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
