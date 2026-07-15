import { describe, expect, it, vi } from "vitest";

import { generateChatGroupIconWithOpenAI } from "@/lib/chat-group-avatar-generation.server";
import {
  DEFAULT_CHAT_GROUP_ICON,
  isChatGroupIconName,
} from "@/lib/chat-group-icons";
import { CHAT_GROUP_ICON_SEMANTIC_CORPUS } from "./fixtures/chat-group-icon-semantic-corpus";

describe("chat group icon semantic corpus", () => {
  it("meets the deterministic selection release gates", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const results = await Promise.all(
      CHAT_GROUP_ICON_SEMANTIC_CORPUS.map(async (testCase) => {
        const ai = {
          run: vi.fn(async () => ({
            choices: [{ message: { content: testCase.modelOutput } }],
          })),
        };
        const icon = await generateChatGroupIconWithOpenAI(ai, testCase.title);
        return { testCase, icon };
      }),
    );

    const successful = results.filter(({ icon }) => icon !== null);
    const acceptable = results.filter(
      ({ testCase, icon }) =>
        icon !== null && testCase.acceptable.includes(icon),
    );
    const failures = results
      .filter(
        ({ testCase, icon }) =>
          icon === null ||
          !testCase.acceptable.includes(icon) ||
          testCase.unacceptable.includes(icon),
      )
      .map(({ testCase, icon }) => ({
        id: testCase.id,
        modelOutput: testCase.modelOutput,
        icon,
      }));

    expect(CHAT_GROUP_ICON_SEMANTIC_CORPUS.length).toBeGreaterThanOrEqual(75);
    expect(
      successful.every(
        ({ testCase, icon }) =>
          icon !== DEFAULT_CHAT_GROUP_ICON &&
          isChatGroupIconName(icon) &&
          !testCase.unacceptable.includes(icon),
      ),
    ).toBe(true);
    expect(successful.length / results.length).toBeGreaterThanOrEqual(0.95);
    expect(
      acceptable.length / results.length,
      JSON.stringify(failures, null, 2),
    ).toBeGreaterThanOrEqual(0.9);
  });
});
