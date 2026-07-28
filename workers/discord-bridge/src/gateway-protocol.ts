import type { DiscordMessageContentMode } from "./types.js";

export const DISCORD_GATEWAY_VERSION = 10;
export const DISCORD_GATEWAY_INTENTS: Record<DiscordMessageContentMode, number> = {
  full: 33_281,
  mention_only: 513,
};

export type DiscordGatewayCloseAction = "resume" | "reidentify" | "fatal";

const FATAL_CLOSE_CODES = new Set([4004, 4010, 4011, 4012, 4013, 4014]);
const REIDENTIFY_CLOSE_CODES = new Set([4003, 4005, 4007, 4009]);

export function classifyDiscordGatewayClose(code: number): DiscordGatewayCloseAction {
  if (FATAL_CLOSE_CODES.has(code)) return "fatal";
  if (REIDENTIFY_CLOSE_CODES.has(code)) return "reidentify";
  return "resume";
}

export function discordReconnectDelayMs(
  attempt: number,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.floor(Math.max(0, Math.min(1, random())) * ceiling);
}

export function discordInitialHeartbeatDelayMs(
  intervalMs: number,
  random: () => number = Math.random,
): number {
  return Math.floor(Math.max(0, Math.min(1, random())) * Math.max(0, intervalMs));
}

export function discordIdentifyPayload(args: {
  token: string;
  mode: DiscordMessageContentMode;
  shardId: number;
  shardCount: number;
}) {
  return {
    op: 2,
    d: {
      token: args.token,
      intents: DISCORD_GATEWAY_INTENTS[args.mode],
      properties: {
        os: "cloudflare",
        browser: "camelai",
        device: "camelai",
      },
      shard: [args.shardId, args.shardCount],
    },
  };
}

export function discordResumePayload(args: {
  token: string;
  sessionId: string;
  sequence: number;
}) {
  return {
    op: 6,
    d: {
      token: args.token,
      session_id: args.sessionId,
      seq: args.sequence,
    },
  };
}

export function normalizeDiscordThreadName(value: string): string {
  const normalized = value
    .replace(/<@!?\d+>/g, "")
    .replace(/\s+/gu, " ")
    .trim();
  return Array.from(normalized || "Camel request").slice(0, 100).join("");
}

function preferredDiscordSplitIndex(text: string, maximum: number): number {
  if (text.length <= maximum) return text.length;
  const candidates = [text.lastIndexOf("\n\n", maximum), text.lastIndexOf("\n", maximum), text.lastIndexOf(" ", maximum)];
  const preferred = Math.max(...candidates);
  let index = preferred >= Math.floor(maximum * 0.55) ? preferred : maximum;
  const before = text.charCodeAt(index - 1);
  const after = text.charCodeAt(index);
  if (
    before >= 0xd800 && before <= 0xdbff &&
    after >= 0xdc00 && after <= 0xdfff
  ) {
    index -= 1;
  }
  return index;
}

function fenceState(text: string, current: string | null): string | null {
  let open = current;
  const fencePattern = /(^|\n)```([^\n`]*)/g;
  for (const match of text.matchAll(fencePattern)) {
    open = open === null ? (match[2]?.trim() || "") : null;
  }
  return open;
}

/** Splits Discord text without truncating and keeps every chunk valid Markdown. */
export function splitDiscordMessage(text: string, limit = 2_000): string[] {
  if (!text) return [];
  if (limit < 16) throw new Error("Discord message limit is too small");
  const chunks: string[] = [];
  let remaining = text;
  let openFence: string | null = null;

  while (remaining.length > 0) {
    const prefix = openFence === null ? "" : `\`\`\`${openFence}\n`;
    let bodyLimit = limit - prefix.length;
    let splitAt = preferredDiscordSplitIndex(remaining, bodyLimit);
    let body = remaining.slice(0, splitAt);
    let nextFence = fenceState(body, openFence);
    let suffix = nextFence === null || splitAt === remaining.length ? "" : "\n```";

    if (prefix.length + body.length + suffix.length > limit) {
      bodyLimit -= suffix.length;
      splitAt = preferredDiscordSplitIndex(remaining, bodyLimit);
      body = remaining.slice(0, splitAt);
      nextFence = fenceState(body, openFence);
      suffix = nextFence === null || splitAt === remaining.length ? "" : "\n```";
    }

    chunks.push(`${prefix}${body}${suffix}`);
    remaining = remaining.slice(splitAt);
    openFence = nextFence;
  }

  return chunks;
}

export async function stableDiscordNonce(
  operationId: string,
  chunkIndex: number,
): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${operationId}:${chunkIndex}`),
  ));
  const encoded = btoa(String.fromCharCode(...digest.slice(0, 16)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  return `c-${encoded}`;
}

const DISCORD_MENTION_ONLY_NOTICE =
  "Mention @Camel in every follow-up while Discord is in mention-only mode.";

export function discordOutboundTextWithNotice(
  text: string | undefined,
  mode: "full" | "mention_only",
  noticeSent: boolean,
): { text: string | undefined; includedNotice: boolean } {
  if (mode !== "mention_only" || noticeSent) {
    return { text, includedNotice: false };
  }
  return {
    text: text ? `${text}\n\n${DISCORD_MENTION_ONLY_NOTICE}` : DISCORD_MENTION_ONLY_NOTICE,
    includedNotice: true,
  };
}
