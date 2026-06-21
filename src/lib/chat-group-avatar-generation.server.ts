import {
  runAuxiliaryAiChatCompletion,
  type AuxiliaryAiBinding,
  type AuxiliaryAiMetadata,
  type AuxiliaryAiRunContext,
} from "./auxiliary-ai.server";
import { isEmoji } from "./avatar";
import emojiRegex from "emoji-regex";

const CHAT_GROUP_EMOJI_GENERATION_SYSTEM_PROMPT = [
  "Return exactly one emoji for this chat group title.",
  "If you include any explanation, it will be ignored.",
  "If the title is generic, choose 💬.",
].join(" ");

export const CHAT_GROUP_EMOJI_MAX_OUTPUT_TOKENS = 32;

export type ChatGroupEmojiGenerationMetadata = AuxiliaryAiMetadata;
export type ChatGroupEmojiGenerationContext = AuxiliaryAiRunContext;

export type ChatGroupEmojiSanitizeReason =
  | "ok"
  | "empty_output"
  | "no_emoji"
  | "multiple_emoji";

export interface ChatGroupEmojiSanitizeResult {
  emoji: string | null;
  reason: ChatGroupEmojiSanitizeReason;
  outputLength: number;
  emojiMatchCount: number;
}

function stripSimpleEmojiWrappers(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^["'`]+|["'`.,;:!]+$/g, "")
    .trim();
}

export function parseGeneratedChatGroupEmoji(
  value: string | null,
): ChatGroupEmojiSanitizeResult {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return {
      emoji: null,
      reason: "empty_output",
      outputLength: 0,
      emojiMatchCount: 0,
    };
  }

  const cleaned = stripSimpleEmojiWrappers(trimmed);
  if (isEmoji(cleaned)) {
    return {
      emoji: cleaned,
      reason: "ok",
      outputLength: trimmed.length,
      emojiMatchCount: 1,
    };
  }

  const matches = Array.from(
    cleaned.matchAll(emojiRegex()),
    (match) => match[0],
  );
  if (matches.length === 1 && isEmoji(matches[0])) {
    return {
      emoji: matches[0],
      reason: "ok",
      outputLength: trimmed.length,
      emojiMatchCount: 1,
    };
  }

  return {
    emoji: null,
    reason: matches.length > 1 ? "multiple_emoji" : "no_emoji",
    outputLength: trimmed.length,
    emojiMatchCount: matches.length,
  };
}

export function sanitizeGeneratedChatGroupEmoji(value: string | null): string | null {
  return parseGeneratedChatGroupEmoji(value).emoji;
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

  const parsed = parseGeneratedChatGroupEmoji(generated);
  if (!parsed.emoji) {
    console.warn("Chat group emoji generation returned unusable output", {
      reason: parsed.reason,
      orgId: metadata?.orgId,
      workspaceId: metadata?.workspaceId,
      threadId: metadata?.threadId,
      groupId: metadata?.groupId,
      outputLength: parsed.outputLength,
      emojiMatchCount: parsed.emojiMatchCount,
    });
  }
  return parsed.emoji;
}
