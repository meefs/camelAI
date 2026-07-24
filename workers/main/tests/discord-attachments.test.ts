import { describe, expect, it } from "vitest";
import {
  deterministicDiscordFilename,
  readResponseBodyAtMost,
  validDiscordAttachmentUrl,
} from "../src/discord-events-queue.js";
import type { DiscordBridgeDeliveryMessage } from "../src/discord-types.js";

function event(): DiscordBridgeDeliveryMessage {
  return {
    kind: "message",
    discordMessageId: "message-1",
    guildId: "guild-1",
    channelId: "channel-1",
    parentChannelId: "channel-1",
    threadId: null,
    integrationId: "integration-1",
    orgId: "org-1",
    workspaceId: "workspace-1",
    bindingVersion: 1,
    ordinal: 1,
    content: "",
    messageType: 0,
    author: { id: "user-1", username: "user", globalName: null, guildNickname: null },
    mentions: [],
    attachments: [],
    timestamp: null,
    contentMode: "full",
    starter: true,
  };
}

describe("Discord attachment ingress", () => {
  it("accepts only exact HTTPS Discord CDN attachment paths", () => {
    expect(validDiscordAttachmentUrl(
      "https://cdn.discordapp.com/attachments/123/456/report.csv?ex=signed",
    )?.hostname).toBe("cdn.discordapp.com");
    expect(validDiscordAttachmentUrl("http://cdn.discordapp.com/attachments/1/2/file")).toBeNull();
    expect(validDiscordAttachmentUrl("https://cdn.discordapp.com/avatars/1/2.png")).toBeNull();
    expect(validDiscordAttachmentUrl("https://cdn.discordapp.com.evil.test/attachments/1/2/file"))
      .toBeNull();
  });

  it("builds deterministic, sanitized retry paths", () => {
    const attachment = {
      id: "attachment-1",
      filename: "../../résumé\n.csv",
      contentType: "text/csv",
      size: 10,
      url: "https://cdn.discordapp.com/attachments/1/2/file",
    };
    expect(deterministicDiscordFilename(event(), attachment)).toBe(
      deterministicDiscordFilename(event(), attachment),
    );
    expect(deterministicDiscordFilename(event(), attachment)).not.toMatch(/[\/\r\n]/);
  });

  it("stops streaming as soon as the body exceeds the remaining limit", async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5, 6]));
        controller.close();
      },
    }));

    await expect(readResponseBodyAtMost(response, 5)).resolves.toBeNull();
  });

  it("returns an exact bounded body without data loss", async () => {
    const response = new Response(new Uint8Array([1, 2, 3, 4]));
    const body = await readResponseBodyAtMost(response, 4);
    expect(Array.from(new Uint8Array(body!))).toEqual([1, 2, 3, 4]);
  });
});
