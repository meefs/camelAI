import {
  runAuxiliaryAiChatCompletion,
  type AuxiliaryAiBinding,
  type AuxiliaryAiMetadata,
  type AuxiliaryAiRunContext,
} from "./auxiliary-ai.server";
import { isEmoji } from "./avatar";
import emojiRegex from "emoji-regex";

const CHAT_GROUP_EMOJI_GENERATION_SYSTEM_PROMPT = [
  "Pick a single emoji that represents this chat group title.",
  "Reply with only the emoji.",
].join(" ");

export const CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS = 32;

export type ChatGroupEmojiGenerationMetadata = AuxiliaryAiMetadata;
export type ChatGroupEmojiGenerationContext = AuxiliaryAiRunContext;

// The auxiliary model is small and frequently wraps the emoji in quotes, prose,
// or trailing extra emoji. Rather than enforce an exact output shape (which made
// generation flaky), just take the first emoji that appears anywhere in the
// output. If there is none, the caller leaves the group on its default avatar.
export function sanitizeGeneratedChatGroupEmoji(
  value: string | null,
): string | null {
  const match = value?.match(emojiRegex())?.[0] ?? null;
  return match && isEmoji(match) ? match : null;
}

export async function generateChatGroupEmojiWithOpenAI(
  ai: AuxiliaryAiBinding | undefined | null,
  titleOrName: string,
  metadata?: ChatGroupEmojiGenerationMetadata,
  context?: ChatGroupEmojiGenerationContext,
): Promise<string | null> {
  const title = titleOrName.trim();
  if (!title) return null;
  const generated = await runAuxiliaryAiChatCompletion(ai, {
    systemPrompt: CHAT_GROUP_EMOJI_GENERATION_SYSTEM_PROMPT,
    userMessage: title,
    maxTokens: CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS,
    metadata,
    context,
  });

  const emoji = sanitizeGeneratedChatGroupEmoji(generated);
  if (!emoji) {
    console.warn("Chat group emoji generation returned no usable emoji", {
      orgId: metadata?.orgId,
      workspaceId: metadata?.workspaceId,
      threadId: metadata?.threadId,
      groupId: metadata?.groupId,
    });
  }
  return emoji;
}
